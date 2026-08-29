// Callback — Netlify Function (Functions 2.0).
//
// On submit it (1) records the request via Netlify Forms so nothing is lost
// even if the call fails, then (2) places an outbound call through Vapi from
// our number to the visitor's, passing the form's name and question as the
// {{name}} and {{question}} assistant variables.
//
// SECRETS live only in env vars (local .env + Netlify dashboard):
//   VAPI_API_KEY, VAPI_PHONE_NUMBER_ID, VAPI_ASSISTANT_ID
//
// ABUSE HARDENING — added after the 22 Aug 2025 toll-fraud (IRSF) incident, in
// which a bot submitted ~40 requests with +972 numbers and gibberish names,
// burning ~150 Vapi minutes and ~$55 of Twilio spend. Every outbound call
// costs real money, so the guards run cheapest-first and refuse by default:
//   1. honeypot          — hidden form field; filled means bot; silent drop
//   2. country allowlist — ALLOWED_CALLING_CODES, mirrors Twilio geo perms
//   3. input sanity      — E.164 shape + per-country national-number length
//   4. per-IP burst      — in-memory, per instance (fast first line)
//   5. per-phone 24h     — Netlify Blobs, persistent across instances
//   6. global hourly cap — Netlify Blobs, bounds worst-case spend per hour
// Every refusal is logged with a "REJECTED: <reason>" prefix so an attack is
// visible at a glance when scanning the function log.

import { getStore } from '@netlify/blobs';

const VAPI_URL = 'https://api.vapi.ai/call';

// --- Country allowlist ---------------------------------------------------
// ALLOWED_CALLING_CODES is a comma-separated list of E.164 calling codes we
// are willing to dial — keep it in step with the Twilio account's geo
// permissions so we never pay for a call to a high-tariff destination.
// Default: India, US/Canada, Thailand, UAE, Saudi Arabia, UK.
const DEFAULT_CALLING_CODES = '91,1,66,971,966,44';

function allowedCallingCodes() {
  const raw = process.env.ALLOWED_CALLING_CODES || DEFAULT_CALLING_CODES;
  return raw
    .split(',')
    .map((c) => c.trim().replace(/^\+/, ''))
    .filter((c) => /^\d{1,4}$/.test(c));
}

// --- NANP (+1) area-code blocklist ---------------------------------------
// "1" on the allowlist means *all* of the North American Numbering Plan, not
// just the US and Canada. Twilio lists each Caribbean NANP nation as its own
// geo-permission entry, and several are long-standing IRSF payout
// destinations, so a bare "1" does not actually mirror the Twilio settings the
// way "91" or "44" do. These area codes are refused even though +1 is allowed.
//
// Deliberately NOT blocked: the US territories (787/939 Puerto Rico, 340 US
// Virgin Islands, 671 Guam, 684 American Samoa, 670 N. Mariana Islands). They
// carry US-level tariffs, are not meaningful fraud payout targets, and could
// plausibly be real US business.
//
// Override with BLOCKED_NANP_AREA_CODES (comma-separated) if the firm ever
// takes on a client in one of these; an empty value disables the check.
const DEFAULT_BLOCKED_NANP =
  // Sovereign Caribbean / Atlantic NANP nations.
  '242,246,264,268,284,345,441,473,649,658,664,721,758,767,784,809,829,849,868,869,876,' +
  // Premium-rate and variable-cost ranges inside the US/Canada plan itself.
  '900,976,700,500,521,522,523,524,525,526,527,528,529,533,544,566,577,588';

function blockedNanpAreaCodes() {
  const raw = process.env.BLOCKED_NANP_AREA_CODES ?? DEFAULT_BLOCKED_NANP;
  return new Set(
    raw
      .split(',')
      .map((c) => c.trim())
      .filter((c) => /^\d{3}$/.test(c))
  );
}

// Expected length of the NATIONAL part (the digits after the calling code).
// This throws out malformed numbers before we ever hand them to Vapi. The
// ranges are deliberately a little loose so legitimate landlines still get
// through; the job is to catch gibberish, not to be a numbering-plan validator.
const NATIONAL_LENGTH = {
  91: { min: 10, max: 10, name: 'India' },
  1: { min: 10, max: 10, name: 'US/Canada' },
  66: { min: 8, max: 9, name: 'Thailand' },
  971: { min: 8, max: 9, name: 'UAE' },
  966: { min: 8, max: 9, name: 'Saudi Arabia' },
  44: { min: 9, max: 10, name: 'UK' },
};

// Longest-prefix match, so "971" wins over a shorter entry that also matches.
function matchCallingCode(digits, codes) {
  let best = null;
  for (const code of codes) {
    if (digits.startsWith(code) && (!best || code.length > best.length)) best = code;
  }
  return best;
}

// --- Rate limits ---------------------------------------------------------
// Per-IP burst guard: in-memory, so it is per function instance and resets on
// cold start. It is the cheap first line only — the Blobs limits below are the
// ones that actually hold across instances.
const RATE_LIMIT = 3;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const hits = new Map(); // ip -> [timestamps]

function allow(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    hits.set(ip, recent);
    return false;
  }
  recent.push(now);
  hits.set(ip, recent);
  return true;
}

// Persistent limits (Netlify Blobs — same store-and-fail-open pattern as the
// chat logging in ask.mjs).
//
// PER_PHONE_LIMIT: a real person needs one callback, occasionally a second if
// they missed it. Two per number per day is generous, and it stops a single
// number being redialled in a loop.
//
// HOURLY_CAP: the blast radius. Genuine traffic here is a handful of callbacks
// a WEEK, so eight in a single hour sits far above any real peak while capping
// worst-case burn at ~8 calls/hr instead of the ~40 the Aug 22 bot got through.
// Tunable via CALLBACK_HOURLY_CAP without a code change.
const GUARD_STORE = 'callback-guard';
const GUARD_TIMEOUT_MS = 2500; // cap so a hung store can never stall a caller
const PER_PHONE_LIMIT = 2;
const PER_PHONE_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_HOURLY_CAP = 8;

function hourlyCap() {
  const n = Number.parseInt(process.env.CALLBACK_HOURLY_CAP || '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_HOURLY_CAP;
}

function hourKey(now) {
  return `hourly/${now.toISOString().slice(0, 13)}`; // hourly/YYYY-MM-DDTHH
}

async function withTimeout(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout`)), GUARD_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Read both persistent counters. FAIL-OPEN: if Blobs is unreachable we return
// "allowed" and lean on the in-memory per-IP guard, exactly as the chat log
// swallows its own failures. A rate limiter that 500s is worse than one that
// occasionally lets a call through.
async function checkPersistentLimits(phone, now) {
  try {
    const store = getStore(GUARD_STORE);
    const phoneKey = `phone/${phone.replace(/^\+/, '')}`;
    const [phoneRec, hourRec] = await withTimeout(
      Promise.all([
        store.get(phoneKey, { type: 'json' }),
        store.get(hourKey(now), { type: 'json' }),
      ]),
      'guard read'
    );

    const recent = (phoneRec?.hits || []).filter((t) => now.getTime() - t < PER_PHONE_WINDOW_MS);
    if (recent.length >= PER_PHONE_LIMIT) return { ok: false, scope: 'phone', recent };

    const count = hourRec?.count || 0;
    if (count >= hourlyCap()) return { ok: false, scope: 'global', recent, count };

    return { ok: true, recent, count };
  } catch (err) {
    console.warn('callback guard read failed (fail-open, non-fatal):', err.message);
    return { ok: true, degraded: true, recent: [], count: 0 };
  }
}

// Commit the counters immediately before dialling. Best-effort and fail-open
// for the same reason as the read: a write failure must not cost a visitor
// their callback.
async function commitPersistentLimits(phone, now, state) {
  if (state.degraded) return;
  try {
    const store = getStore(GUARD_STORE);
    const phoneKey = `phone/${phone.replace(/^\+/, '')}`;
    await withTimeout(
      Promise.all([
        store.setJSON(phoneKey, { hits: [...state.recent, now.getTime()] }),
        store.setJSON(hourKey(now), { count: (state.count || 0) + 1 }),
      ]),
      'guard write'
    );
  } catch (err) {
    // Read-modify-write is not atomic, so two simultaneous submissions can
    // read the same count. At this traffic volume the drift is at most a call
    // or two per hour, which the cap already has headroom for.
    console.warn('callback guard write failed (fail-open, non-fatal):', err.message);
  }
}

// Combine a country code and a local number into E.164 (e.g. +919876543210),
// stripping spaces, dashes, brackets and any trunk/leading zeros.
function normalizePhone(countryCode, raw) {
  const r = String(raw || '').replace(/[\s\-().]/g, '');

  // A full international number typed into the phone field wins outright,
  // whether written as +… or with the 00 international prefix.
  if (r.startsWith('+')) return '+' + r.slice(1).replace(/\D/g, '');
  if (r.startsWith('00')) return '+' + r.slice(2).replace(/\D/g, '');

  const national = r.replace(/\D/g, '').replace(/^0+/, ''); // digits, no trunk 0
  const cc = String(countryCode || '').replace(/\D/g, '').replace(/^0+/, '');
  return '+' + cc + national;
}

const E164 = /^\+[1-9]\d{7,14}$/;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function clientIp(req) {
  return (
    req.headers.get('x-nf-client-connection-ip') ||
    (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    'unknown'
  );
}

// Record to Netlify Forms (best-effort). Posts a form-encoded submission for
// the "callback" form to the site root; failures never block the call.
async function recordSubmission(req, fields) {
  try {
    // Record to the SAME origin the function is serving (localhost under
    // netlify dev, the live domain in production) — never to a different site.
    const host = req.headers.get('host');
    const proto =
      req.headers.get('x-forwarded-proto') ||
      (host && host.includes('localhost') ? 'http' : 'https');
    const base = `${proto}://${host}`;
    const body = new URLSearchParams({ 'form-name': 'callback', ...fields }).toString();
    await fetch(`${base}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch (err) {
    console.warn('Netlify Forms recording failed:', err.message);
  }
}

const GEO_REFUSAL =
  "We can't call that region yet — email george@askgeko.com and we'll reach out.";
const BAD_NUMBER = 'Please enter a valid phone number, including the country code.';

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  const ip = clientIp(req);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid request.' }, 400);
  }

  // Honeypot first: a filled bot-field means a bot. Drop it silently — the
  // response is indistinguishable from success so the bot learns nothing, and
  // nothing downstream (env checks, Forms, Vapi) is touched.
  if (String(body['bot-field'] || '').trim() !== '') {
    console.warn(`REJECTED: honeypot — ip=${ip}`);
    return json({ ok: true, message: "Thanks — we'll call you shortly." });
  }

  const key = process.env.VAPI_API_KEY;
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;
  const assistantId = process.env.VAPI_ASSISTANT_ID;
  if (!key || !phoneNumberId || !assistantId) {
    console.error('Vapi env vars are not set.');
    return json({ error: "The callback service isn't available right now. Please email george@askgeko.com." }, 500);
  }

  // Cap the free-text fields: they are interpolated into assistant variables,
  // so there is no reason to carry an essay through to Vapi.
  const name = String(body.name || '').trim().slice(0, 100);
  const company = String(body.company || '').trim().slice(0, 100);
  const question = String(body.question || '').trim().slice(0, 500);
  if (!name) return json({ error: 'Please tell us your name.' }, 400);

  const phone = normalizePhone(body.countrycode, body.phone);
  if (!E164.test(phone)) {
    console.warn(`REJECTED: format — not E.164 phone=${phone} ip=${ip}`);
    return json({ error: BAD_NUMBER }, 400);
  }

  // --- Country allowlist -------------------------------------------------
  const digits = phone.slice(1);
  const code = matchCallingCode(digits, allowedCallingCodes());
  if (!code) {
    console.warn(`REJECTED: country — phone=${phone} name=${JSON.stringify(name)} ip=${ip}`);
    // 400, not 403: `netlify dev` treats a 403 on a POST as "not here" and
    // retries the same request against /api/callback.html, .htm,
    // /index.html and /index.htm — five function invocations for one
    // submission, which is precisely the cost this guard exists to avoid.
    // The refusal reason is carried by the message, not the status code.
    return json({ error: GEO_REFUSAL }, 400);
  }

  // --- Per-country length sanity -----------------------------------------
  const national = digits.slice(code.length);
  const rule = NATIONAL_LENGTH[code];
  if (rule && (national.length < rule.min || national.length > rule.max)) {
    console.warn(
      `REJECTED: format — phone=${phone} wrong length for +${code} (${rule.name}): ` +
        `got ${national.length}, expected ${rule.min}-${rule.max} ip=${ip}`
    );
    return json({ error: BAD_NUMBER }, 400);
  }
  // Catch obvious filler such as +91 1111111111.
  if (/^(\d)\1+$/.test(national)) {
    console.warn(`REJECTED: format — phone=${phone} repeated-digit filler ip=${ip}`);
    return json({ error: BAD_NUMBER }, 400);
  }

  // --- NANP: area-code shape, then the blocklist -------------------------
  if (code === '1') {
    const area = national.slice(0, 3);
    const exchange = national.slice(3, 6);
    // In the NANP both the area code and the exchange must start 2-9, so this
    // throws out fabricated numbers like +1 123 456 7890 for free.
    if (!/^[2-9]\d\d$/.test(area) || !/^[2-9]\d\d$/.test(exchange)) {
      console.warn(`REJECTED: format — phone=${phone} invalid NANP area/exchange ip=${ip}`);
      return json({ error: BAD_NUMBER }, 400);
    }
    if (blockedNanpAreaCodes().has(area)) {
      console.warn(
        `REJECTED: country — phone=${phone} blocked NANP area=${area} ` +
          `name=${JSON.stringify(name)} ip=${ip}`
      );
      return json({ error: GEO_REFUSAL }, 400);
    }
  }

  // --- Rate limits -------------------------------------------------------
  if (!allow(ip)) {
    console.warn(`REJECTED: rate — scope=ip ip=${ip} phone=${phone}`);
    return json(
      { error: "You've requested a few callbacks recently. Please try again later, or email george@askgeko.com." },
      429
    );
  }

  const now = new Date();
  const limits = await checkPersistentLimits(phone, now);
  if (!limits.ok) {
    if (limits.scope === 'phone') {
      console.warn(
        `REJECTED: rate — scope=phone phone=${phone} ` +
          `hits=${limits.recent.length}/${PER_PHONE_LIMIT} in 24h ip=${ip}`
      );
      return json(
        { error: "We've already called that number today. Please email george@askgeko.com and we'll pick it up from there." },
        429
      );
    }
    console.warn(
      `REJECTED: rate — scope=global count=${limits.count}/${hourlyCap()} this hour ` +
        `phone=${phone} ip=${ip}`
    );
    return json(
      { error: "We're at our callback limit for this hour. Please try again shortly, or email george@askgeko.com." },
      429
    );
  }

  // Commit the counters before dialling: a call we are about to pay for must
  // count against the quota even if Vapi then fails.
  await commitPersistentLimits(phone, now, limits);

  // Record first so the request is captured even if the call fails.
  await recordSubmission(req, { name, company, phone, question });

  // Place the outbound call via Vapi.
  let vapiRes;
  try {
    vapiRes = await fetch(VAPI_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phoneNumberId,
        assistantId,
        customer: { number: phone, name: name || undefined },
        assistantOverrides: {
          variableValues: {
            name,
            question: question || "what you're working on",
          },
        },
      }),
    });
  } catch (err) {
    console.error('Vapi request failed:', err);
    return json(
      { error: "We've saved your request but couldn't place the call just now. We'll follow up, or email george@askgeko.com." },
      502
    );
  }

  if (!vapiRes.ok) {
    const detail = await vapiRes.text().catch(() => '');
    console.error('Vapi error', vapiRes.status, detail);
    return json(
      { error: "We've saved your request but couldn't place the call just now. We'll follow up, or email george@askgeko.com." },
      502
    );
  }

  return json({ ok: true, message: 'Calling you now — your phone should ring within a minute.' });
};

// Route at /api/callback (also reachable at /.netlify/functions/callback).
export const config = { path: '/api/callback' };

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
// Protection: per-IP rate limit, server-side phone validation, and polite
// errors if Vapi fails.

const VAPI_URL = 'https://api.vapi.ai/call';

// Rate limit: a small number of callbacks per visitor per hour.
// NB: in-memory, so it is per function instance and resets on cold start —
// a lightweight abuse guard, not a hard quota. Swap to Netlify Blobs for a
// persistent, cross-instance limit.
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

// Combine a country code and a local number into E.164 (e.g. +919876543210).
function normalizePhone(countryCode, raw) {
  let r = String(raw || '').replace(/[\s\-().]/g, '');
  if (r.startsWith('+')) return r; // full international number entered
  r = r.replace(/^0+/, ''); // drop trunk/leading zeros
  let c = String(countryCode || '').replace(/[\s\-().]/g, '');
  if (!c.startsWith('+')) c = '+' + c.replace(/^\++/, '');
  return c + r;
}

const E164 = /^\+[1-9]\d{7,14}$/;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  const key = process.env.VAPI_API_KEY;
  const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;
  const assistantId = process.env.VAPI_ASSISTANT_ID;
  if (!key || !phoneNumberId || !assistantId) {
    console.error('Vapi env vars are not set.');
    return json({ error: "The callback service isn't available right now. Please email george@askgeko.com." }, 500);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid request.' }, 400);
  }

  // Honeypot: a filled bot-field means a bot — pretend success and drop it.
  if (String(body['bot-field'] || '').trim() !== '') {
    return json({ ok: true, message: "Thanks — we'll call you shortly." });
  }

  const name = String(body.name || '').trim();
  const company = String(body.company || '').trim();
  const question = String(body.question || '').trim();
  if (!name) return json({ error: 'Please tell us your name.' }, 400);

  const phone = normalizePhone(body.countrycode, body.phone);
  if (!E164.test(phone)) {
    return json({ error: 'Please enter a valid phone number, including the country code.' }, 400);
  }

  // Rate limit per visitor.
  const ip =
    req.headers.get('x-nf-client-connection-ip') ||
    (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    'unknown';
  if (!allow(ip)) {
    return json(
      { error: "You've requested a few callbacks recently. Please try again later, or email george@askgeko.com." },
      429
    );
  }

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

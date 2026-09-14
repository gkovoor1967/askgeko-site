// Vapi end-of-call webhook -> Zoho CRM Lead — Netlify Function (Functions 2.0).
//
// Vapi POSTs a server message here when a call ends. We verify a shared
// secret, take only the "end-of-call-report" message, pull out who called and
// what they asked, mint a fresh Zoho access token, and create a Lead.
//
// SECRETS live only in env vars (local .env + Netlify dashboard):
//   VAPI_WEBHOOK_SECRET  — must equal the x-vapi-secret header Vapi sends
//   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN
//
// INDIA data centre only: accounts.zoho.in (OAuth), www.zohoapis.in (CRM).
//
// Resilience: if Zoho fails we log clearly but still return 200 so Vapi does
// NOT retry — the callback is already captured by Netlify Forms as a fallback.

import { getStore } from '@netlify/blobs';

const ZOHO_TOKEN_URL = 'https://accounts.zoho.in/oauth/v2/token';
const ZOHO_LEADS_URL = 'https://www.zohoapis.in/crm/v8/Leads';

// --- Monologue guard -----------------------------------------------------
// The 13 Sep fraud calls were not conversations. The far end answered and
// played a YouTube motivational clip down the line for ten solid minutes; our
// assistant got "Hello, am I speaking with..." out and was then talked over
// until Vapi's own duration cap ended the call. IRSF pays per minute, so the
// monologue WAS the product.
//
// A silence timeout cannot catch this — the line was never silent, it was
// wall-to-wall audio. What is actually anomalous is the reverse: OUR side
// never got a turn. So we track how long it has been since the assistant last
// spoke, and hang up from our side once that passes the threshold.
//
// This also catches the honest versions of the same shape: voicemail
// greetings, hold music, and IVR trees that talk at us forever.
const CALL_GUARD_STORE = 'call-guard';
const DEFAULT_MONOLOGUE_TIMEOUT_S = 90;
const GUARD_TIMEOUT_MS = 2000; // never let the guard delay our 200 to Vapi

function monologueTimeoutMs() {
  const n = Number.parseInt(process.env.CALL_MONOLOGUE_TIMEOUT_SECONDS || '', 10);
  return (Number.isFinite(n) && n > 0 ? n : DEFAULT_MONOLOGUE_TIMEOUT_S) * 1000;
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

// Did OUR side speak in this event? Vapi labels the assistant "assistant" in
// speech-update and transcript, but "bot" inside conversation-update's message
// list, so accept both rather than trusting one spelling.
function assistantSpokeIn(message) {
  const isOurs = (role) => role === 'assistant' || role === 'bot';
  if (message.type === 'speech-update' || message.type === 'transcript') {
    return isOurs(message.role);
  }
  if (message.type === 'conversation-update') {
    const msgs = message.messages || message.artifact?.messages || [];
    const last = msgs.filter((m) => m && m.role !== 'system').pop();
    return last ? isOurs(last.role) : false;
  }
  return false;
}

async function endLiveCall(controlUrl, callId, idleSec) {
  await fetch(controlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'end-call' }),
  });
  console.warn(
    `ENDED: monologue — callId=${callId} assistant had no turn for ${idleSec}s ` +
      `(limit ${monologueTimeoutMs() / 1000}s); hung up from our side`
  );
}

// Best-effort and FAIL-OPEN, like every other guard on this path: if Blobs or
// the control URL misbehaves we log and let the call run, because
// maxDurationSeconds on the dial side is still the backstop.
async function monologueGuard(message) {
  try {
    const call = message.call || {};
    const callId = call.id || message.callId;
    const controlUrl = call.monitor?.controlUrl || message.monitor?.controlUrl;
    if (!callId || !controlUrl) return;

    const store = getStore(CALL_GUARD_STORE);
    const key = `call/${callId}`;
    const now = Date.now();

    const rec = (await withTimeout(store.get(key, { type: 'json' }), 'guard read')) || null;
    if (rec?.ended) return; // already hung up; don't spam the control URL

    // The first event we see starts the clock. If the assistant never gets a
    // turn at all, that is precisely the case we want to catch.
    if (!rec || assistantSpokeIn(message)) {
      await withTimeout(store.setJSON(key, { lastAssistant: now }), 'guard write');
      return;
    }

    const idleMs = now - (rec.lastAssistant || now);
    if (idleMs >= monologueTimeoutMs()) {
      await endLiveCall(controlUrl, callId, Math.round(idleMs / 1000));
      await withTimeout(store.setJSON(key, { ...rec, ended: true }), 'guard write');
    }
  } catch (err) {
    console.warn('monologue guard failed (fail-open, non-fatal):', err.message);
  }
}

// Drop the per-call record once the call is over, so the store does not grow.
async function clearCallGuard(message) {
  try {
    const callId = message.call?.id || message.callId;
    if (!callId) return;
    await withTimeout(getStore(CALL_GUARD_STORE).delete(`call/${callId}`), 'guard delete');
  } catch {
    /* housekeeping only */
  }
}

// Zoho's Description field is generous but not unlimited; keep well under it.
const DESCRIPTION_MAX = 30000;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Mint a short-lived access token from the long-lived refresh token.
async function getZohoAccessToken() {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.ZOHO_CLIENT_ID,
    client_secret: process.env.ZOHO_CLIENT_SECRET,
    refresh_token: process.env.ZOHO_REFRESH_TOKEN,
  });
  const res = await fetch(ZOHO_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  // Zoho answers 200 even on errors, signalling failure via an `error` field.
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error || !data.access_token) {
    throw new Error(`Zoho token refresh failed: ${data.error || res.status}`);
  }
  return data.access_token;
}

// Build the Lead Description from question + summary + transcript, truncated.
function buildDescription({ question, summary, transcript }) {
  const parts = [];
  if (question) parts.push(`Question / topic:\n${question}`);
  if (summary) parts.push(`Call summary:\n${summary}`);
  if (transcript) parts.push(`Transcript:\n${transcript}`);
  let text = parts.join('\n\n');
  if (text.length > DESCRIPTION_MAX) {
    text = text.slice(0, DESCRIPTION_MAX) + '\n… [truncated]';
  }
  return text;
}

// Pull the fields we care about out of Vapi's end-of-call-report message.
// Vapi nests things variously across versions, so read defensively.
function extractCallData(message) {
  const call = message.call || {};
  const artifact = message.artifact || {};

  // Assistant variable values carry {{name}} / {{question}} we passed at dial.
  const vars =
    message.assistant?.variableValues ||
    message.assistantOverrides?.variableValues ||
    call.assistantOverrides?.variableValues ||
    artifact?.assistantOverrides?.variableValues ||
    {};

  const name = String(vars.name || '').trim();
  const question = String(vars.question || '').trim();

  // Caller phone: on an outbound call the customer is the person we rang.
  const phone = String(
    message.customer?.number || call.customer?.number || ''
  ).trim();

  // Duration in seconds if Vapi provided start/end, else a direct field.
  let durationSec = message.durationSeconds ?? message.duration ?? null;
  if (durationSec == null && message.startedAt && message.endedAt) {
    durationSec = Math.round(
      (new Date(message.endedAt) - new Date(message.startedAt)) / 1000
    );
  }

  const endedReason = String(message.endedReason || '').trim();
  const summary = String(message.summary || artifact.summary || '').trim();
  const transcript = String(
    message.transcript || artifact.transcript || ''
  ).trim();

  return { name, question, phone, durationSec, endedReason, summary, transcript };
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  // 1) Verify the shared secret. Reject anything without the right header.
  const expected = process.env.VAPI_WEBHOOK_SECRET;
  const provided = req.headers.get('x-vapi-secret');
  if (!expected || !provided || provided !== expected) {
    console.warn('vapi-webhook: rejected request with bad/missing x-vapi-secret.');
    return json({ error: 'Unauthorized.' }, 401);
  }

  // 2) Parse the body. Vapi wraps the payload in { message: { ... } }.
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON.' }, 400);
  }
  const message = body.message || body;

  // 3) Live-call events: run the monologue guard, then acknowledge. These
  //    arrive repeatedly while a call is in progress, which is what gives the
  //    guard a heartbeat to evaluate on even when our side never gets a turn.
  const LIVE_TYPES = new Set(['speech-update', 'transcript', 'conversation-update']);
  if (LIVE_TYPES.has(message.type)) {
    await monologueGuard(message);
    return json({ ok: true, ignored: message.type });
  }

  // 4) Only act on end-of-call-report; acknowledge everything else with 200.
  if (message.type !== 'end-of-call-report') {
    return json({ ok: true, ignored: message.type || 'unknown' });
  }

  await clearCallGuard(message);

  const data = extractCallData(message);
  console.log(
    `vapi-webhook: end-of-call from ${data.phone || 'unknown'} ` +
      `(${data.name || 'no name'}), reason=${data.endedReason || 'n/a'}, ` +
      `duration=${data.durationSec ?? 'n/a'}s`
  );

  // 5) Create the Zoho Lead. Any failure here is logged but still returns 200
  //    so Vapi does not retry (Netlify Forms already captured the request).
  try {
    const accessToken = await getZohoAccessToken();

    const lead = {
      Last_Name: data.name || 'Unknown Caller',
      Lead_Source: 'GeKo voice callback',
      Description: buildDescription(data),
    };
    if (data.phone) lead.Phone = data.phone;

    const res = await fetch(ZOHO_LEADS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ data: [lead] }),
    });
    const result = await res.json().catch(() => ({}));

    // Zoho returns per-record status inside data[0].code === 'SUCCESS'.
    const record = result?.data?.[0];
    if (!res.ok || record?.code !== 'SUCCESS') {
      console.error(
        'vapi-webhook: Zoho Lead create failed:',
        res.status,
        JSON.stringify(result)
      );
    } else {
      console.log('vapi-webhook: Zoho Lead created, id =', record.details?.id);
    }
  } catch (err) {
    console.error('vapi-webhook: error creating Zoho Lead:', err.message);
  }

  // Always acknowledge so Vapi does not retry.
  return json({ ok: true });
};

// Route at /api/vapi-webhook (also at /.netlify/functions/vapi-webhook).
export const config = { path: '/api/vapi-webhook' };

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

const ZOHO_TOKEN_URL = 'https://accounts.zoho.in/oauth/v2/token';
const ZOHO_LEADS_URL = 'https://www.zohoapis.in/crm/v8/Leads';

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

  // 3) Only act on end-of-call-report; acknowledge everything else with 200.
  if (message.type !== 'end-of-call-report') {
    return json({ ok: true, ignored: message.type || 'unknown' });
  }

  const data = extractCallData(message);
  console.log(
    `vapi-webhook: end-of-call from ${data.phone || 'unknown'} ` +
      `(${data.name || 'no name'}), reason=${data.endedReason || 'n/a'}, ` +
      `duration=${data.durationSec ?? 'n/a'}s`
  );

  // 4) Create the Zoho Lead. Any failure here is logged but still returns 200
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

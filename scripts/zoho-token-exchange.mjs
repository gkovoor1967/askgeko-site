// Zoho refresh-token exchange — LOCAL, ONE-TIME. Not deployed.
//
// Exchanges a one-time Zoho grant code for a long-lived refresh token, then
// writes ZOHO_REFRESH_TOKEN into .env. Run it once after generating a fresh
// grant code in the Zoho API console (grant codes expire in ~10 minutes).
//
//   node scripts/zoho-token-exchange.mjs
//
// It reads ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET and ZOHO_GRANT_CODE from .env.
// INDIA data centre only: token endpoint is accounts.zoho.in (never .com).
//
// SECURITY: this prints ONLY success/failure — never the token values. The
// refresh token is written straight into .env (gitignored), not echoed.

import { readFileSync, writeFileSync } from 'node:fs';

const ENV_PATH = new URL('../.env', import.meta.url);
const TOKEN_URL = 'https://accounts.zoho.in/oauth/v2/token';

// Minimal .env parser — we only need three keys, values may contain '='.
function readEnv(path) {
  const text = readFileSync(path, 'utf8');
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return { text, env };
}

// Write (or replace) a single KEY=value line in .env, preserving the rest.
function upsertEnv(text, key, value) {
  const line = `${key}=${value}`;
  if (new RegExp(`^${key}=.*$`, 'm').test(text)) {
    return text.replace(new RegExp(`^${key}=.*$`, 'm'), line);
  }
  const prefix = text.endsWith('\n') || text === '' ? '' : '\n';
  return (
    text +
    prefix +
    '\n# Long-lived Zoho refresh token (minted once from the grant code).\n' +
    line +
    '\n'
  );
}

const { text, env } = readEnv(ENV_PATH);
const clientId = env.ZOHO_CLIENT_ID;
const clientSecret = env.ZOHO_CLIENT_SECRET;
const grantCode = env.ZOHO_GRANT_CODE;

if (!clientId || !clientSecret || !grantCode) {
  console.error(
    'Missing one of ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_GRANT_CODE in .env.'
  );
  process.exit(1);
}

// Zoho's token endpoint takes form-encoded params in the query string / body.
const params = new URLSearchParams({
  grant_type: 'authorization_code',
  client_id: clientId,
  client_secret: clientSecret,
  code: grantCode,
});

let res, data;
try {
  res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  data = await res.json();
} catch (err) {
  console.error('Network error contacting accounts.zoho.in:', err.message);
  process.exit(1);
}

// Zoho returns HTTP 200 even for errors, with an { error: ... } field.
if (!res.ok || data.error || !data.refresh_token) {
  console.error(
    'Token exchange failed:',
    data.error || `HTTP ${res.status}` ,
    '\nMost likely the grant code expired (~10 min) or was already used.',
    '\nGenerate a fresh grant code and try again.'
  );
  process.exit(1);
}

const updated = upsertEnv(text, 'ZOHO_REFRESH_TOKEN', data.refresh_token);
writeFileSync(ENV_PATH, updated);

console.log('Success — refresh token written to .env (value not shown).');
console.log('You can now delete ZOHO_GRANT_CODE from .env; it is single-use.');

// Read the Ask GeKo chat logs from Netlify Blobs and write a local CSV.
// LOCAL tool — not deployed.
//
// Output: chat-logs.csv in the project root, newest first, columns:
//   date, time, sessionId, question, response, model
// (date/time are UTC, taken from each entry's ISO timestamp.)
//
// Optional filter:
//   node scripts/read-chat-logs.mjs --since 2026-07-01
//
// ---------------------------------------------------------------------------
// HOW TO RUN IT
//
// A) Against the LIVE site's logs (what you'll normally use).
//    You use the Netlify dashboard, not `netlify login`, so give the script a
//    Personal Access Token + the site id via two environment variables:
//
//      1. Create a token: Netlify dashboard -> User settings -> Applications
//         -> "Personal access tokens" -> New access token. Copy it.
//      2. Find the site id: Site configuration -> General -> "Site ID"
//         (a UUID like 12345678-90ab-...).
//      3. Run (PowerShell):
//           $env:NETLIFY_AUTH_TOKEN = "your-token"
//           $env:NETLIFY_SITE_ID    = "your-site-id"
//           node scripts/read-chat-logs.mjs
//         (bash: NETLIFY_AUTH_TOKEN=... NETLIFY_SITE_ID=... node scripts/...)
//
//    The token is a secret — don't paste it into any committed file. Setting
//    it inline for one command (as above) keeps it out of the repo.
//
// B) Against LOCAL `netlify dev` test logs (no token needed).
//    `netlify dev` keeps a sandbox blob store on disk under .netlify/. When no
//    NETLIFY_AUTH_TOKEN is set, this script reads that sandbox directly, so
//    you can just run:
//           node scripts/read-chat-logs.mjs
//    after sending a few test chats through `netlify dev`.
//
// ---------------------------------------------------------------------------

import { writeFileSync, readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getStore } from '@netlify/blobs';

const STORE = 'chat-logs';
const OUT = new URL('../chat-logs.csv', import.meta.url);
const SANDBOX_DIR = fileURLToPath(new URL('../.netlify/blobs-serve/entries', import.meta.url));

// --- parse args ------------------------------------------------------------
let since = null;
const sinceIdx = process.argv.indexOf('--since');
if (sinceIdx !== -1) {
  since = process.argv[sinceIdx + 1];
  if (!since || !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    console.error('--since expects a date like 2026-07-01');
    process.exit(1);
  }
}

// --- collect entries -------------------------------------------------------
// Each entry is the parsed value object: { ts, sessionId, question, response,
// model }. We gather them from the live cloud store when credentials are
// present, otherwise from the local `netlify dev` sandbox on disk.
const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
const token = process.env.NETLIFY_AUTH_TOKEN;

let entries;
if (siteID && token) {
  entries = await readCloud(siteID, token);
} else if (existsSync(SANDBOX_DIR)) {
  console.log('No NETLIFY_AUTH_TOKEN set — reading the local `netlify dev` sandbox store.');
  entries = readLocalSandbox();
} else {
  console.error(
    'No logs source found. Set NETLIFY_AUTH_TOKEN + NETLIFY_SITE_ID to read the\n' +
      'live store (mode A), or run some chats through `netlify dev` first to create\n' +
      'the local sandbox (mode B). See the comment at the top of this file.'
  );
  process.exit(1);
}

// Keep only on/after --since (compare the UTC date from each ts).
if (since) entries = entries.filter((e) => String(e.ts || '').slice(0, 10) >= since);

if (entries.length === 0) {
  console.log(since ? `No log entries on or after ${since}.` : 'No log entries yet.');
  process.exit(0);
}

// Newest first, by timestamp.
entries.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));

// --- write CSV -------------------------------------------------------------
// Quote every field and double internal quotes so commas / quotes / newlines
// in questions and responses can't break the columns.
function csv(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

const header = ['date', 'time', 'sessionId', 'question', 'response', 'model'];
const lines = [header.map(csv).join(',')];
for (const e of entries) {
  const iso = String(e.ts || '');
  const date = iso.slice(0, 10);
  const time = iso.slice(11, 19); // HH:MM:SS (UTC)
  lines.push(
    [date, time, e.sessionId, e.question, e.response, e.model].map(csv).join(',')
  );
}
// Prepend a BOM so Excel opens the UTF-8 file with the right encoding.
writeFileSync(OUT, '﻿' + lines.join('\r\n') + '\r\n');

console.log(`Wrote ${entries.length} row(s) to chat-logs.csv${since ? ` (since ${since})` : ''}.`);

// --- sources ---------------------------------------------------------------

// Mode A: the live Netlify Blobs store.
async function readCloud(siteID, token) {
  let store;
  try {
    store = getStore({ name: STORE, siteID, token, consistency: 'strong' });
  } catch (err) {
    console.error('Could not open the Blobs store:', err.message);
    process.exit(1);
  }
  let keys;
  try {
    const { blobs } = await store.list();
    keys = blobs.map((b) => b.key);
  } catch (err) {
    console.error('Failed to list the store:', err.message);
    console.error('Check NETLIFY_AUTH_TOKEN / NETLIFY_SITE_ID are correct.');
    process.exit(1);
  }
  const out = [];
  for (const key of keys) {
    try {
      const value = await store.get(key, { type: 'json' });
      if (value) out.push(value);
    } catch (err) {
      console.warn(`Skipping unreadable entry ${key}:`, err.message);
    }
  }
  return out;
}

// Mode B: the local `netlify dev` sandbox, stored on disk as one file per
// entry under .netlify/blobs-serve/entries/<context>/site:<store>/<key>.
// Path segments are URL-encoded (e.g. "site%3Achat-logs"); each file holds the
// raw JSON value we wrote. This layout is a local dev convenience only — the
// live store (mode A) never touches disk.
function readLocalSandbox() {
  const out = [];
  const wanted = `site:${STORE}`;
  for (const ctx of readdirSync(SANDBOX_DIR)) {
    const ctxPath = join(SANDBOX_DIR, ctx);
    if (!statSync(ctxPath).isDirectory()) continue;
    for (const storeDir of readdirSync(ctxPath)) {
      if (decodeURIComponent(storeDir) !== wanted) continue;
      collectFiles(join(ctxPath, storeDir), out);
    }
  }
  return out;
}

function collectFiles(dir, out) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      collectFiles(p, out); // key segments become nested folders
    } else {
      try {
        out.push(JSON.parse(readFileSync(p, 'utf8')));
      } catch {
        /* ignore anything that isn't one of our JSON entries */
      }
    }
  }
}

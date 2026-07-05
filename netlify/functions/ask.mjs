// Ask GeKo assistant — Netlify Function (Functions 2.0 style).
//
// The browser POSTs the running conversation to this function; the function
// prepends the system prompt from askgeko-assistant.md and relays the chat to
// OpenRouter (which is OpenAI-compatible), then returns the reply.
//
// SECRETS: the API key and model live ONLY in environment variables, never in
// the client. Set them in a local .env for `netlify dev`, and in the Netlify
// dashboard for production:
//   OPENROUTER_API_KEY   — your OpenRouter key (required)
//   OPENROUTER_MODEL     — model slug (optional; defaults below)

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'google/gemini-2.5-flash';

// Keep requests small and replies tight.
const MAX_MESSAGES = 20; // most recent turns we forward upstream
const MAX_CHARS = 4000; // per-message content cap
const MAX_TOKENS = 600; // cap the reply length

// --- System prompt -------------------------------------------------------
// Loaded from askgeko-assistant.md so the owner can edit one file. Read once
// per cold start; if it can't be found we fall back to a minimal prompt so the
// assistant never hard-crashes. (netlify.toml bundles the file via
// `included_files` so it's readable in production too.)
function loadSystemPrompt() {
  try {
    const raw = readFileSync(join(process.cwd(), 'askgeko-assistant.md'), 'utf8');
    // Everything from the "## System prompt" heading onward is grounding.
    const marker = '## System prompt';
    const idx = raw.indexOf(marker);
    return (idx === -1 ? raw : raw.slice(idx + marker.length)).trim();
  } catch (err) {
    console.warn('Could not read askgeko-assistant.md; using fallback prompt:', err.message);
    return (
      'You are "Ask GeKo", the warm, concise AI advisor for Ask GeKo Advisory ' +
      'LLP, a boutique management consultancy in Bengaluru. Help visitors think ' +
      'through leadership and strategy questions and explain how the firm works. ' +
      'Never invent client details. For real engagements, invite them to email ' +
      'george@askgeko.com.'
    );
  }
}

const SYSTEM_PROMPT = loadSystemPrompt();

export default async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed.' }, 405);
  }

  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    console.error('OPENROUTER_API_KEY is not set.');
    return json({ error: 'The assistant is not configured yet. Please try again later.' }, 500);
  }
  const model = process.env.OPENROUTER_MODEL || DEFAULT_MODEL;

  // Parse and validate the incoming conversation.
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid request body.' }, 400);
  }

  const incoming = Array.isArray(body?.messages) ? body.messages : null;
  if (!incoming) {
    return json({ error: 'Expected a "messages" array.' }, 400);
  }

  // Keep only clean user/assistant turns; trim, then cap count and length.
  const conversation = incoming
    .filter(
      (m) =>
        m &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        m.content.trim() !== ''
    )
    .slice(-MAX_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));

  if (conversation.length === 0) {
    return json({ error: 'No message to answer.' }, 400);
  }

  const payload = {
    model,
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...conversation],
    max_tokens: MAX_TOKENS,
  };

  // Call OpenRouter (OpenAI-compatible chat completions).
  let upstream;
  try {
    upstream = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        // Optional attribution headers OpenRouter uses for ranking.
        'HTTP-Referer': 'https://askgeko.com',
        'X-Title': 'Ask GeKo',
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error('OpenRouter request failed:', err);
    return json({ error: 'The assistant is unreachable right now. Please try again.' }, 502);
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    console.error('OpenRouter error', upstream.status, detail);
    return json({ error: 'The assistant had trouble responding. Please try again.' }, 502);
  }

  const data = await upstream.json().catch(() => null);
  const reply = data?.choices?.[0]?.message?.content?.trim();
  if (!reply) {
    console.error('OpenRouter returned no content:', JSON.stringify(data));
    return json({ error: 'The assistant returned an empty reply. Please try again.' }, 502);
  }

  return json({ reply });
};

// Small helper: JSON response with a status code.
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Route this function at /api/ask (Netlify Functions 2.0 path routing). It is
// also reachable at /.netlify/functions/ask.
export const config = { path: '/api/ask' };

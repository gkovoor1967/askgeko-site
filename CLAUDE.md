# Ask GeKo Advisory — website

Standing context for Claude Code. Build a marketing website for Ask GeKo Advisory LLP, a boutique management consultancy ("The Leadership Alchemists") based in Bengaluru, India. Domain: askgeko.com (registered on GoDaddy). The owner, George, is new to Claude Code — explain changes briefly, work one task per session, and prefer simple, well-commented solutions over clever ones. Ask before adding a new tool or dependency.

## Stack
- **Astro** — static site; keep page content in Markdown the owner can edit himself.
- **Hosting:** Netlify (free tier), deployed from a GitHub repo.
- **Assistant brain:** OpenRouter (OpenAI-compatible) called from a **Netlify Function**. The model and key are environment variables, never in client code.
- **Contact:** Netlify Forms, emailing submissions to george@askgeko.com.
- No client-side secrets; no browser storage of anything sensitive.

## Design direction
Premium, restrained, automotive-luxury feel (Mercedes / BMW / McKinsey). Restraint over decoration: generous whitespace, near-monochrome, gold as a **thin accent only** — never large gold fills. One slow load animation, no bounce. Mobile-responsive and accessible (visible focus states, `prefers-reduced-motion` respected).

Design tokens:
- `--ink #15110C` — warm near-black, primary dark
- `--ink-2 #1F1A13` — raised dark surface
- `--bone #F4EFE6` — warm off-white, light sections
- `--bone-2 #ECE5D8` — secondary light surface
- `--gold #C9A24B` — accent: hairlines, the logo, small marks
- `--gold-deep #9A7B33` — gold text on light backgrounds
- `--mute-dark #A99E89` / `--mute-light #6E665A` — muted text

Type:
- Display / headlines: **Cormorant Garamond** (elegant serif, used large and sparingly)
- Body / UI: **Inter**
- Eyebrows / section labels: Inter, uppercase, letter-spacing ~.3em
- The assistant renders its replies in the serif (the firm "speaking"); the visitor's messages in the sans.

Logo: use the owner's **original gold compass logo** placed in `/public` — do NOT redraw or recreate it. The compass needle points north-east with a flame at its tip; that is the brand mark, keep it intact wherever the logo appears. Use a transparent-background copy on dark sections; otherwise place the logo on light sections. A reference comp of the intended look may be placed in `/reference/askgeko-design-direction.html` — match its spirit, not every pixel.

## Pages
1. **Home** — full-height dark hero: logo, "Ask GeKo Advisory", tagline "The Leadership Alchemists", one positioning line, a thin gold rule. Brief links into the sections below.
2. **About** — "Who we are" (one bold lede + two short paragraphs) and "Why work with us".
3. **Partners** — George Kovoor (Founding Partner) and Neena Kovoor (Partner): photo, 3–4 line bio, email, LinkedIn.
4. **Clients** — named clients only, no project details: Apax, Diageo, Arthur D. Little, Beyond Snack, Canadian Crystalline, AlgoSynth. Render as a refined name wall with gold hairline separators.
5. **Articles** — an index built from Markdown files, plus a full on-site page per article. Index cards show title, date and excerpt (newest first). George's own pieces open as full editorial pages at `/articles/<slug>` (`src/pages/articles/[slug].astro`); each ends with an "Originally published on LinkedIn →" link. Third-party coverage is marked `type: "mention"` and stays excerpt-only, linking out to the source instead. Article body is plain Markdown in the file; an optional `heroImage` (+ `heroAlt`, `heroCaption`) frontmatter field adds a lead image. Images live in `/public/articles/` and are referenced by path. Slugs are the filename minus the leading `YYYY-MM-DD-` date.
6. **Ask GeKo** — the AI assistant (below) plus a "go further" path that emails george@askgeko.com.
7. **Footer** (every page) — social links (X & Instagram @askgeko, LinkedIn), contact email, © Ask GeKo Advisory LLP, askgeko.com.

Copy lives in `askgeko-content.md` — use it; do not invent firm facts. Keep all text spare; a premium layout wants little text.

## The Ask GeKo assistant
- A chat widget in the Ask GeKo section. The browser calls a Netlify Function; the function calls OpenRouter and returns the reply. The OpenRouter key and model live in env vars: `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`. Start with `OPENROUTER_MODEL = google/gemini-2.5-flash`.
- OpenRouter is OpenAI-compatible: base URL `https://openrouter.ai/api/v1`, send the model slug from the env var. The function sends the system prompt from `askgeko-assistant.md` plus the running conversation. Keep replies concise.
- To switch models or add a "cheap model first, escalate if needed" rule later, change the env var or add a small routing rule **in the function** — never hard-code the model.
- When a visitor wants real help, collect name / email / question and email it to george@askgeko.com (reuse the Netlify Forms setup).

## Out of scope for v1 (leave room, do not build)
A premium "Research" section selling proprietary data (RAG over datasets), payments (Razorpay / Stripe), logins / gating, a Vapi voice agent, YouTube embeds. Structure the site so a Research section and basic auth could be added later without a rebuild. For any future proprietary-data answers: route through a model that does not train on inputs, disable provider retention for those calls, and return summaries — never raw datasets.

## Build sequence
1. Scaffold Astro; shared layout (header with logo, footer with socials); brand tokens + fonts; get `npm run dev` running.
2. Build the Home hero.
3. **Deploy early:** push to GitHub, connect Netlify, confirm the live URL works — before building more pages.
4. About, Partners, Clients pages.
5. Articles from Markdown — full on-site pages via a content collection and `/articles/[slug]` route; images in `/public/articles/`.
6. Ask GeKo: chat UI + Netlify Function → OpenRouter (env vars); test locally with `netlify dev`.
7. Contact-to-email via Netlify Forms; wire the assistant's "go further" handoff.
8. Polish: page titles / meta descriptions, favicon from the logo, transparent logo for dark sections, mobile, accessibility.
9. Point GoDaddy DNS to Netlify; set env vars in the Netlify dashboard; generate a QR code linking to `/ask`.

## Working style
One task per session. Show diffs and explain briefly. Commit to git after each working step. Prefer Astro components and plain CSS using the tokens above; avoid heavy dependencies.

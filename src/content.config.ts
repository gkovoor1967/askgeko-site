// Content collections for the site.
// Articles (CLAUDE.md, page 5) are full on-site pages built from these
// Markdown files: frontmatter (below) + the article body. Each file in
// src/content/articles/ is one entry the owner can edit by hand — the body
// is plain Markdown, and dropping in a hero image path is optional.
import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const articles = defineCollection({
  // Load every Markdown file in the articles folder.
  loader: glob({ pattern: '**/*.md', base: './src/content/articles' }),
  schema: z.object({
    title: z.string(), // headline shown on the list + article page
    date: z.date(), // publish date (YYYY-MM-DD) — used to sort newest first
    excerpt: z.string(), // 1–2 line teaser in George's voice (list + intro)
    linkedin: z.string().url(), // the original LinkedIn post this links to
    // "article" = George's own piece, rendered in full on its own page;
    // "mention" = external coverage (excerpt + outbound link only).
    type: z.enum(['article', 'mention']).default('article'),
    source: z.string().optional(), // for mentions: who published it
    // Optional lead image shown at the top of the article page. Path is
    // relative to /public (e.g. "/articles/growth-is-granular.png").
    heroImage: z.string().optional(),
    heroAlt: z.string().optional(), // accessible description of the hero
    heroCaption: z.string().optional(), // small caption under the hero
  }),
});

export const collections = { articles };

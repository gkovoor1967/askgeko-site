// Content collections for the site.
// The Articles page (CLAUDE.md, page 5) is "a list built from Markdown files;
// each = title, date, short excerpt, link out to LinkedIn."
// Each file in src/content/articles/ is one entry the owner can edit by hand.
import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const articles = defineCollection({
  // Load every Markdown file in the articles folder.
  loader: glob({ pattern: '**/*.md', base: './src/content/articles' }),
  schema: z.object({
    title: z.string(), // headline shown on the Articles list
    date: z.date(), // publish date (YYYY-MM-DD) — used to sort newest first
    excerpt: z.string(), // 1–2 line teaser in George's voice
    linkedin: z.string().url(), // the post this links out to
    // "article" = George's own piece; "mention" = external coverage of him.
    type: z.enum(['article', 'mention']).default('article'),
    source: z.string().optional(), // for mentions: who published it
  }),
});

export const collections = { articles };

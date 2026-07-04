// @ts-check
import { defineConfig } from 'astro/config';

// Static site. Netlify serves the built /dist. Nothing exotic here yet —
// the Netlify adapter for the assistant Function comes in a later step.
export default defineConfig({
  site: 'https://askgeko.com',
});

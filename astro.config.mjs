// @ts-check
import { defineConfig } from 'astro/config';

// Static site. Netlify serves the built /dist.
export default defineConfig({
  site: 'https://askgeko.com',
  // The Ask GeKo chat now lives on the homepage and the "go further" form on
  // /contact, so /ask is retired — redirect old links so they don't 404.
  // For a static build Astro emits a redirect page at /ask.
  redirects: {
    '/ask': '/contact',
  },
});

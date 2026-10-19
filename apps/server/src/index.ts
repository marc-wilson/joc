import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app.ts';
import { requestToken, tokenMatches } from './auth.ts';
import { ownerFrom } from './owner.ts';

// One shared token for the hosted site, so everything it stores belongs to one owner. Unset in
// local dev, where everything is open and belongs to `local`.
const token = process.env.JOC_TOKEN || undefined;
if (!token) {
  console.warn('JOC_TOKEN is not set: the API is open to anyone who can reach this server.');
}
const shared = ownerFrom('shared');
const local = ownerFrom('local');

const app = createApp({
  token,
  resolveOwner: (c) => {
    if (!token) return local;
    return tokenMatches(requestToken(c), token) ? shared : undefined;
  },
});

// In production the server also serves the built dashboard, so everything is one origin.
const webDist = process.env.WEB_DIST;
if (webDist) {
  app.use('/*', serveStatic({ root: webDist }));
  app.get('*', serveStatic({ root: webDist, path: 'index.html' }));
}

const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`JOC server listening on http://localhost:${info.port}`);
});

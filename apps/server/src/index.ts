import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app.ts';
import { githubAuth } from './github.ts';

const port = Number(process.env.PORT ?? 3000);
const publicUrl = (process.env.JOC_PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, '');
const clientId = process.env.JOC_GITHUB_CLIENT_ID;
const clientSecret = process.env.JOC_GITHUB_CLIENT_SECRET;

// Without GitHub sign-in the server is open to anyone who reaches it: fine on a laptop, never
// in production.
if (!clientId || !clientSecret) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JOC_GITHUB_CLIENT_ID and JOC_GITHUB_CLIENT_SECRET are required in production');
  }
  console.warn('GitHub sign-in is not configured: the API is open, as local development.');
}

const app = createApp({
  publicUrl,
  github:
    clientId && clientSecret
      ? githubAuth({ clientId, clientSecret, redirectUri: `${publicUrl}/auth/github/callback` })
      : undefined,
});

// In production the server also serves the built dashboard, so everything is one origin.
const webDist = process.env.WEB_DIST;
if (webDist) {
  app.use('/*', serveStatic({ root: webDist }));
  app.get('*', serveStatic({ root: webDist, path: 'index.html' }));
}

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`JOC server listening on http://localhost:${info.port}`);
});

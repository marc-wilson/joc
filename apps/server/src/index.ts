import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { closeClient } from '@joc/db';
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

const shutdown = new AbortController();

const app = createApp({
  publicUrl,
  shutdown: shutdown.signal,
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

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`JOC server listening on http://localhost:${info.port}`);
});

// Kubernetes sends SIGTERM once the pod is out of the Service (after the chart's preStop pause),
// with the new pod already serving. Stop taking connections, end the live streams so browsers
// reconnect to the new pod, let requests in flight finish, then exit. Node as PID 1 would
// otherwise ignore SIGTERM and hang until the grace period's SIGKILL.
const SHUTDOWN_MS = 10_000;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    console.log(`${signal}: shutting down`);
    shutdown.abort();
    server.close(() => {
      void closeClient()
        .catch((error: unknown) => console.error('Closing MongoDB failed:', error))
        .finally(() => process.exit(0));
    });
    // A connection that won't finish (a stuck request) doesn't hold the exit up for long.
    setTimeout(() => process.exit(0), SHUTDOWN_MS).unref();
  });
}

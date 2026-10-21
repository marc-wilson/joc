import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { closeClient } from '@joc/db';
import { createApp } from './app.ts';
import { bus } from './bus.ts';
import { githubAuth } from './github.ts';
import { githubAppApi } from './github-app.ts';
import { createWebhooks } from './github-webhook.ts';
import { readPluginVersion, webBuild } from './version.ts';

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

// The JOC GitHub App: its webhooks bring GitHub data, and its id and key read what webhooks
// can't carry. Without a webhook secret, each machine's plugin reads GitHub through `gh` instead.
const appId = process.env.JOC_GITHUB_APP_ID;
const appKey = process.env.JOC_GITHUB_APP_PRIVATE_KEY;
const webhookSecret = process.env.JOC_GITHUB_WEBHOOK_SECRET;
if (webhookSecret && !(appId && appKey)) {
  console.warn(
    'JOC_GITHUB_APP_ID or JOC_GITHUB_APP_PRIVATE_KEY is unset: webhooks work, but no backfill, files or team reviews.',
  );
}
const webhooks = webhookSecret
  ? createWebhooks(webhookSecret, {
      api: appId && appKey ? githubAppApi({ appId, privateKey: appKey }) : undefined,
    })
  : undefined;
if (!webhooks) console.warn('No GitHub App webhooks: GitHub data comes from each machine via gh.');

const shutdown = new AbortController();
// In production the server also serves the built dashboard, so everything is one origin.
const webDist = process.env.WEB_DIST;

const app = createApp({
  publicUrl,
  pluginVersion: readPluginVersion(),
  build: webBuild(webDist),
  shutdown: shutdown.signal,
  github:
    clientId && clientSecret
      ? githubAuth({
          clientId,
          clientSecret,
          redirectUri: `${publicUrl}/auth/github/callback`,
          app: !!webhooks,
        })
      : undefined,
  webhooks,
  // Only needed when the server can't read the App's slug from GitHub (no App id and key).
  appSlug: process.env.JOC_GITHUB_APP_SLUG || undefined,
});

// Hear live updates written through the other server processes (pods), until shutdown.
void bus.start(shutdown.signal);

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

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { getClient } from '@joc/db';
import { MessagesReport, SessionReport, type StreamEvent } from '@joc/protocol';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { addMessages, listMessages, onMessages } from './messages.ts';
import { applyReport, listSessions, onSessionUpdate } from './sessions.ts';

const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));

app.get('/health/db', async (c) => {
  try {
    await getClient().db().command({ ping: 1 });
    return c.json({ ok: true });
  } catch (error) {
    return c.json({ ok: false, error: String(error) }, 503);
  }
});

app.post('/api/reports', async (c) => {
  const parsed = SessionReport.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  const session = await applyReport(parsed.data);
  // 202 for a stale report: accepted, but a newer one already won.
  return session ? c.json(session) : c.body(null, 202);
});

app.get('/api/sessions', async (c) => c.json(await listSessions()));

app.post('/api/messages', async (c) => {
  const parsed = MessagesReport.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
  return c.json({ added: await addMessages(parsed.data) });
});

app.get('/api/sessions/:id/messages', async (c) => c.json(await listMessages(c.req.param('id'))));

app.get('/api/stream', (c) =>
  streamSSE(
    c,
    async (stream) => {
      const send = (event: StreamEvent) =>
        stream.writeSSE({ event: event.type, data: JSON.stringify(event) });

      // Subscribe before reading the snapshot so no update falls between the two.
      const pending: StreamEvent[] = [];
      let ready = false;
      const publish = (event: StreamEvent) => {
        if (ready) void send(event);
        else pending.push(event);
      };
      const unsubscribers = [
        onSessionUpdate((session) => publish({ type: 'session', session })),
        onMessages((sessionId, items) => publish({ type: 'messages', sessionId, items })),
      ];
      stream.onAbort(() => {
        for (const unsubscribe of unsubscribers) unsubscribe();
      });

      await send({ type: 'snapshot', sessions: await listSessions() });
      for (const event of pending) await send(event);
      ready = true;

      // Keeps idle connections open through proxies, and lets the browser tell a quiet stream
      // from a dead one (it reconnects after STREAM_TIMEOUT_MS of silence).
      while (!stream.aborted) {
        await stream.sleep(15_000);
        if (!stream.aborted) await stream.writeSSE({ event: 'ping', data: '' });
      }
    },
    async (error, stream) => {
      // Close the stream so the browser's EventSource reconnects instead of hanging.
      console.error('Stream failed:', error);
      await stream.close();
    },
  ),
);

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

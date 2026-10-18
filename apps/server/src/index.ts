import { serve } from '@hono/node-server';
import { getClient } from '@joc/db';
import { Hono } from 'hono';

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

const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`JOC server listening on http://localhost:${info.port}`);
});

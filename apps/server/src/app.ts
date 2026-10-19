import { getClient } from '@joc/db';
import {
  type AuthStatus,
  ChangesReport,
  LoginRequest,
  MessagesReport,
  PromptRequest,
  SessionReport,
  type StreamEvent,
} from '@joc/protocol';
import { type Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { setTokenCookie, tokenMatches } from './auth.ts';
import { getChanges, onChanges, saveChanges } from './changes.ts';
import { addMessages, listMessages, onMessages } from './messages.ts';
import type { Owner } from './owner.ts';
import { claimPrompts, queuePrompt } from './prompts.ts';
import { applyReport, listSessions, onSessionUpdate } from './sessions.ts';

export interface AppOptions {
  /** Who a request acts for, or undefined when it isn't signed in. */
  resolveOwner: (c: Context) => Owner | undefined | Promise<Owner | undefined>;
  /** The shared token the sign-in screen accepts; unset where everything is open. */
  token?: string;
}

export type Env = { Variables: { owner: Owner } };

/** The API, without serving: index.ts serves it, and tests call `app.request` directly. */
export function createApp({ resolveOwner, token }: AppOptions): Hono<Env> {
  const app = new Hono<Env>();

  app.get('/health', (c) => c.json({ ok: true }));

  app.get('/health/db', async (c) => {
    try {
      await getClient().db().command({ ping: 1 });
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ ok: false, error: String(error) }, 503);
    }
  });

  // Everything under /api acts for one owner, except what the sign-in screen itself uses.
  const open = ['/api/auth', '/api/login'];
  app.use('/api/*', async (c, next) => {
    if (open.includes(c.req.path)) return next();
    const owner = await resolveOwner(c);
    if (!owner) return c.json({ error: 'Unauthorized' }, 401);
    c.set('owner', owner);
    return next();
  });

  app.get('/api/auth', async (c) =>
    c.json({
      required: token !== undefined,
      signedIn: (await resolveOwner(c)) !== undefined,
    } satisfies AuthStatus),
  );

  app.post('/api/login', async (c) => {
    const parsed = LoginRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    if (!token) return c.body(null, 204);
    if (!tokenMatches(parsed.data.token, token)) return c.json({ error: 'Wrong token' }, 401);
    setTokenCookie(c, token);
    return c.body(null, 204);
  });

  app.post('/api/reports', async (c) => {
    const parsed = SessionReport.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const session = await applyReport(c.get('owner'), parsed.data);
    // 202 for a stale report: accepted, but a newer one already won.
    return session ? c.json(session) : c.body(null, 202);
  });

  app.get('/api/sessions', async (c) => c.json(await listSessions(c.get('owner'))));

  app.post('/api/messages', async (c) => {
    const parsed = MessagesReport.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    return c.json({ added: await addMessages(c.get('owner'), parsed.data) });
  });

  app.get('/api/sessions/:id/messages', async (c) =>
    c.json(await listMessages(c.get('owner'), c.req.param('id'))),
  );

  app.post('/api/changes', async (c) => {
    const parsed = ChangesReport.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    // 202 for a stale report: accepted, but a newer diff already won.
    return (await saveChanges(c.get('owner'), parsed.data))
      ? c.json({ ok: true })
      : c.body(null, 202);
  });

  app.get('/api/sessions/:id/changes', async (c) => {
    const changes = await getChanges(c.get('owner'), c.req.param('id'));
    return changes ? c.json(changes) : c.json({ error: 'No changes reported yet' }, 404);
  });

  // From the dashboard: queue a prompt for the session.
  app.post('/api/sessions/:id/prompts', async (c) => {
    const parsed = PromptRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const id = await queuePrompt(c.get('owner'), c.req.param('id'), parsed.data.text);
    return c.json({ id }, 201);
  });

  // From the session's plugin: take the prompts waiting for it.
  app.post('/api/sessions/:id/prompts/claim', async (c) =>
    c.json({ prompts: await claimPrompts(c.get('owner'), c.req.param('id')) }),
  );

  app.get('/api/stream', (c) =>
    streamSSE(
      c,
      async (stream) => {
        // The stream's owner, fixed for its lifetime: it only ever hears that owner's events.
        const owner = c.get('owner');
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
          onSessionUpdate(owner, (session) => publish({ type: 'session', session })),
          onMessages(owner, (sessionId, items) => publish({ type: 'messages', sessionId, items })),
          onChanges(owner, (sessionId) => publish({ type: 'changes', sessionId })),
        ];
        stream.onAbort(() => {
          for (const unsubscribe of unsubscribers) unsubscribe();
        });

        await send({ type: 'snapshot', sessions: await listSessions(owner) });
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

  return app;
}

import { setTimeout as sleep } from 'node:timers/promises';
import { getClient } from '@joc/db';
import {
  type AuthStatus,
  ChangesReport,
  DeviceApproveRequest,
  DeviceStartRequest,
  DeviceTokenRequest,
  GitHubReport,
  ImageId,
  MAX_IMAGE_BYTES,
  MarkReadRequest,
  MessagesReport,
  NotificationsReport,
  ProblemsReport,
  PromptRequest,
  type ReadsClaim,
  SessionReport,
  type StreamEvent,
} from '@joc/protocol';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import {
  bearerToken,
  clearSessionCookie,
  clientAddress,
  safeReturnPath,
  sameOrigin,
  sessionSecret,
  setOAuthCookies,
  setSessionCookie,
  takeOAuthCookies,
} from './auth.ts';
import { getChanges, onChanges, saveChanges } from './changes.ts';
import type { GitHubAuth } from './github.ts';
import { getGitHub, onGitHub, saveGitHub } from './github-data.ts';
import {
  approveLink,
  createWebSession,
  endWebSession,
  getUser,
  listDevices,
  pendingLink,
  pollLink,
  resolveDeviceToken,
  resolveWebSession,
  revokeDevice,
  signInGitHubUser,
  startLink,
} from './identity.ts';
import { findImages, getImage, saveImage } from './images.ts';
import { addMessages, listMessages, onMessages } from './messages.ts';
import {
  claimReads,
  getNotifications,
  markAllRead,
  markRead,
  onNotifications,
  saveNotifications,
} from './notifications.ts';
import { type Owner, ownerFrom } from './owner.ts';
import { listProblems, saveProblems } from './problems.ts';
import { claimPrompts, queuePrompt } from './prompts.ts';
import { RateLimit } from './rate-limit.ts';
import { newSecret, secretsEqual } from './secrets.ts';
import { applyReport, listHistory, listSessions, onSessionUpdate } from './sessions.ts';

export interface AppOptions {
  /** GitHub sign-in. Without it the server is open and everything belongs to `local`: for local
   * development only (index.ts refuses to run that way in production). */
  github?: GitHubAuth;
  /** Where the dashboard is reached, e.g. `https://joc.marcswilson.com`. */
  publicUrl: string;
  /** Aborted when the server shuts down: live streams end so browsers reconnect elsewhere. */
  shutdown?: AbortSignal;
}

/** How a request proved who it is: a browser session, a machine's token, or open local dev. */
type Via = 'session' | 'device' | 'open';

export type Env = { Variables: { owner: Owner; via: Via } };

const LOCAL = ownerFrom('local');

/** The API, without serving: index.ts serves it, and tests call `app.request` directly. */
export function createApp({
  github,
  publicUrl,
  shutdown = new AbortController().signal,
}: AppOptions): Hono<Env> {
  const app = new Hono<Env>();

  // In memory, as the server runs one replica.
  const linkStarts = new RateLimit(10, 10 * 60_000);
  const linkPolls = new RateLimit(600, 10 * 60_000);
  const approvals = new RateLimit(10, 10 * 60_000);
  // Generous: a session's backlog can carry a few dozen screenshots at once.
  const uploads = new RateLimit(600, 10 * 60_000);

  async function identify(c: Context): Promise<{ owner: Owner; via: Via } | undefined> {
    if (!github) return { owner: LOCAL, via: 'open' };
    const token = bearerToken(c);
    if (token) {
      const owner = await resolveDeviceToken(token);
      return owner && { owner, via: 'device' };
    }
    const secret = sessionSecret(c);
    if (secret) {
      const owner = await resolveWebSession(secret);
      return owner && { owner, via: 'session' };
    }
    return undefined;
  }

  app.get('/health', (c) => c.json({ ok: true }));

  app.get('/health/db', async (c) => {
    try {
      await getClient().db().command({ ping: 1 });
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ ok: false, error: String(error) }, 503);
    }
  });

  // ── Sign-in ────────────────────────────────────────────────────────────────

  app.get('/auth/github', (c) => {
    if (!github) return c.redirect('/');
    const state = newSecret(16);
    setOAuthCookies(c, state, safeReturnPath(c.req.query('return')));
    return c.redirect(github.authorizeUrl(state));
  });

  app.get('/auth/github/callback', async (c) => {
    if (!github) return c.redirect('/');
    const { state, returnTo } = takeOAuthCookies(c);
    const code = c.req.query('code');
    // The state ties the callback to a sign-in this browser started: no forged callbacks.
    if (!code || !state || !secretsEqual(c.req.query('state'), state)) {
      return c.text('Sign-in expired or was started elsewhere. Try again.', 400);
    }
    const profile = await github.profileFor(code);
    if (!profile) return c.text('GitHub sign-in failed. Try again.', 400);
    const owner = await signInGitHubUser(profile);
    setSessionCookie(c, await createWebSession(owner));
    return c.redirect(returnTo);
  });

  app.post('/auth/logout', async (c) => {
    if (!sameOrigin(c)) return c.json({ error: 'Forbidden' }, 403);
    const secret = sessionSecret(c);
    if (secret) await endWebSession(secret);
    clearSessionCookie(c);
    return c.body(null, 204);
  });

  // ── Everything else under /api acts for one owner ──────────────────────────

  // A machine linking itself has no owner yet; the sign-in screen asks before it has one.
  const open = ['/api/auth', '/api/devices/start', '/api/devices/token'];
  app.use('/api/*', async (c, next) => {
    if (open.includes(c.req.path)) return next();
    const who = await identify(c);
    if (!who) return c.json({ error: 'Unauthorized' }, 401);
    // A cookie travels with any request the browser makes, so writes must come from our pages.
    if (who.via === 'session' && !['GET', 'HEAD'].includes(c.req.method) && !sameOrigin(c)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    c.set('owner', who.owner);
    c.set('via', who.via);
    return next();
  });

  app.get('/api/auth', async (c) => {
    const who = await identify(c);
    const user = who && who.via !== 'open' ? await getUser(who.owner) : undefined;
    return c.json({ required: !!github, signedIn: !!who, user } satisfies AuthStatus);
  });

  // ── Linking machines ───────────────────────────────────────────────────────

  app.post('/api/devices/start', async (c) => {
    if (!linkStarts.hit(clientAddress(c))) return c.json({ error: 'Too many requests' }, 429);
    const parsed = DeviceStartRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    return c.json(await startLink(parsed.data.name, publicUrl));
  });

  app.post('/api/devices/token', async (c) => {
    if (!linkPolls.hit(clientAddress(c))) return c.json({ error: 'Too many requests' }, 429);
    const parsed = DeviceTokenRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    return c.json(await pollLink(parsed.data.deviceCode));
  });

  // Approving and managing machines is for a signed-in person, never a machine's own token.
  const person = (c: Context<Env>) => c.get('via') !== 'device';

  // Shares the approval limit, so codes can't be guessed through it either.
  app.get('/api/devices/pending', async (c) => {
    if (!person(c)) return c.json({ error: 'Forbidden' }, 403);
    if (!approvals.hit(c.get('owner'))) {
      return c.json({ error: 'Too many attempts. Wait a few minutes.' }, 429);
    }
    const pending = await pendingLink(c.req.query('code') ?? '');
    return pending
      ? c.json(pending)
      : c.json({ error: "That code didn't match, or it expired." }, 404);
  });

  app.post('/api/devices/approve', async (c) => {
    if (!person(c)) return c.json({ error: 'Forbidden' }, 403);
    const owner = c.get('owner');
    const parsed = DeviceApproveRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    if (!approvals.hit(owner))
      return c.json({ error: 'Too many attempts. Wait a few minutes.' }, 429);
    if (await approveLink(owner, parsed.data.userCode)) return c.body(null, 204);
    return c.json({ error: "That code didn't match, or it expired." }, 404);
  });

  app.get('/api/devices', async (c) => {
    if (!person(c)) return c.json({ error: 'Forbidden' }, 403);
    return c.json(await listDevices(c.get('owner')));
  });

  app.delete('/api/devices/:id', async (c) => {
    if (!person(c)) return c.json({ error: 'Forbidden' }, 403);
    return (await revokeDevice(c.get('owner'), c.req.param('id')))
      ? c.body(null, 204)
      : c.json({ error: 'No such machine' }, 404);
  });

  // What went wrong in a machine's plugin: sent by the plugin, read on the Machines page.
  app.post('/api/problems', async (c) => {
    if (c.get('via') === 'session') return c.json({ error: 'Forbidden' }, 403);
    const parsed = ProblemsReport.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    await saveProblems(c.get('owner'), parsed.data);
    return c.body(null, 204);
  });

  app.get('/api/problems', async (c) => {
    if (!person(c)) return c.json({ error: 'Forbidden' }, 403);
    return c.json(await listProblems(c.get('owner')));
  });

  // ── Sessions ───────────────────────────────────────────────────────────────

  app.post('/api/reports', async (c) => {
    const parsed = SessionReport.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const session = await applyReport(c.get('owner'), parsed.data);
    // 202 for a stale report: accepted, but a newer one already won.
    return session ? c.json(session) : c.body(null, 202);
  });

  app.get('/api/sessions', async (c) => c.json(await listSessions(c.get('owner'))));

  app.get('/api/history', async (c) => c.json(await listHistory(c.get('owner'))));

  // ── GitHub, as the person's plugin reads it through `gh` ────────────────────

  app.post('/api/github', async (c) => {
    const parsed = GitHubReport.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    // 202 for a stale report: accepted, but a newer one already won.
    return (await saveGitHub(c.get('owner'), parsed.data))
      ? c.json({ ok: true })
      : c.body(null, 202);
  });

  app.get('/api/github', async (c) => c.json(await getGitHub(c.get('owner'))));

  // ── GitHub notifications: read by the plugin, marked read from the dashboard ─

  app.post('/api/notifications', async (c) => {
    const parsed = NotificationsReport.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    // 202 for a stale report: accepted, but a newer one already won.
    return (await saveNotifications(c.get('owner'), parsed.data))
      ? c.json({ ok: true })
      : c.body(null, 202);
  });

  app.get('/api/notifications', async (c) => c.json(await getNotifications(c.get('owner'))));

  app.post('/api/notifications/read', async (c) => {
    const parsed = MarkReadRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    await markRead(c.get('owner'), parsed.data.ids);
    return c.body(null, 204);
  });

  app.post('/api/notifications/read-all', async (c) => {
    await markAllRead(c.get('owner'));
    return c.body(null, 204);
  });

  // A machine's plugin takes the queue; a browser has no `gh` to mark them with.
  app.post('/api/notifications/reads/claim', async (c) => {
    if (c.get('via') === 'session') return c.json({ error: 'Forbidden' }, 403);
    return c.json({ ids: await claimReads(c.get('owner')) } satisfies ReadsClaim);
  });

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
    const owner = c.get('owner');
    const parsed = PromptRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    // Only the owner's own images, so a prompt can't hand another person's to their session.
    const images = await findImages(owner, parsed.data.images ?? []);
    if (!images) return c.json({ error: 'No such image' }, 400);
    const id = await queuePrompt(owner, c.req.param('id'), parsed.data.text, images);
    return c.json({ id }, 201);
  });

  // From the session's plugin: take the prompts waiting for it.
  app.post('/api/sessions/:id/prompts/claim', async (c) =>
    c.json({ prompts: await claimPrompts(c.get('owner'), c.req.param('id')) }),
  );

  // ── Images: pasted in the dashboard, or in a session's conversation ─────────

  // The raw bytes, with their type as the Content-Type. Named by the hash of the bytes.
  app.post(
    '/api/images',
    bodyLimit({
      maxSize: MAX_IMAGE_BYTES,
      onError: (c) => c.json({ error: 'Images can be up to 5 MB' }, 413),
    }),
    async (c) => {
      const owner = c.get('owner');
      if (!uploads.hit(owner)) return c.json({ error: 'Too many requests' }, 429);
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      const saved = await saveImage(owner, c.req.header('content-type'), bytes);
      if (saved.ok) return c.json(saved.image, 201);
      return saved.status === 413
        ? c.json({ error: 'Images can be up to 5 MB' }, 413)
        : c.json({ error: 'Only PNG, JPEG, GIF and WebP images' }, 415);
    },
  );

  app.get('/api/images/:id', async (c) => {
    const id = ImageId.safeParse(c.req.param('id'));
    const image = id.success ? await getImage(c.get('owner'), id.data) : undefined;
    if (!image) return c.json({ error: 'No such image' }, 404);
    return c.body(image.data, 200, {
      'content-type': image.type,
      'x-content-type-options': 'nosniff',
      // An id always names the same bytes, but only this person may see them.
      'cache-control': 'private, max-age=31536000, immutable',
      // Opened on its own, the image can run nothing.
      'content-security-policy': "default-src 'none'; sandbox",
    });
  });

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
          onGitHub(owner, () => publish({ type: 'github' })),
          onNotifications(owner, () => publish({ type: 'notifications' })),
        ];
        const unsubscribeAll = () => {
          for (const unsubscribe of unsubscribers) unsubscribe();
        };
        stream.onAbort(unsubscribeAll);

        try {
          await send({ type: 'snapshot', sessions: await listSessions(owner) });
          for (const event of pending) await send(event);
          ready = true;

          // Keeps idle connections open through proxies, and lets the browser tell a quiet
          // stream from a dead one (it reconnects after STREAM_TIMEOUT_MS of silence). On
          // shutdown the stream ends, and the browser reconnects to the server taking over,
          // which starts it with a fresh snapshot.
          while (!stream.aborted && !shutdown.aborted) {
            // Rejects when the shutdown cuts the pause short; the loop condition handles that.
            await sleep(15_000, undefined, { signal: shutdown }).catch(() => undefined);
            if (!stream.aborted && !shutdown.aborted) {
              await stream.writeSSE({ event: 'ping', data: '' });
            }
          }
        } finally {
          unsubscribeAll();
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

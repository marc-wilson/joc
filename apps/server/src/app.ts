import { setTimeout as sleep } from 'node:timers/promises';
import { getClient } from '@joc/db';
import {
  AlertIdsRequest,
  AnswerClaim,
  type AnswerRefused,
  AnswerRequest,
  type AuthStatus,
  answerFits,
  ChangesReport,
  type ClaimedAnswer,
  type ClaimedDeletes,
  CommandsReport,
  DeleteClaim,
  type DeleteRefused,
  DeleteRequest,
  DeleteResult,
  DeviceApproveRequest,
  DeviceStartRequest,
  DeviceTokenRequest,
  GitHubReport,
  ImageId,
  LaunchRequest,
  LaunchResult,
  MAX_IMAGE_BYTES,
  MarkReadRequest,
  MessagesReport,
  NotificationsReport,
  PluginVersion,
  PrefsPatch,
  ProblemsReport,
  PromptRequest,
  type ReadsClaim,
  ReviewSettings,
  reviewPrompt,
  type ServerVersion,
  SessionReport,
  SessionSettings,
  type StreamEvent,
  Waiting,
  WaitingDone,
} from '@joc/protocol';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { clearAlerts, listAlerts, readAlerts } from './alerts.ts';
import { dropAnswer, saveAnswer, waitForAnswer } from './answers.ts';
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
import { type Bus, bus as processBus } from './bus.ts';
import { getChanges, saveChanges } from './changes.ts';
import { getCommands, saveCommands } from './commands.ts';
import { claimDeletes, finishDelete, isDeleted, listDeletes, requestDeletes } from './deletes.ts';
import type { GitHubAuth } from './github.ts';
import { getGitHub, saveGitHub } from './github-data.ts';
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
import { claimLaunches, createLaunch, finishLaunch, listLaunches } from './launches.ts';
import { addMessages, listMessages } from './messages.ts';
import {
  claimReads,
  getNotifications,
  markAllRead,
  markRead,
  saveNotifications,
} from './notifications.ts';
import { type Owner, ownerFrom } from './owner.ts';
import { getPrefs, patchPrefs } from './prefs.ts';
import { listProblems, saveProblems } from './problems.ts';
import { claimPrompts, queuePrompt } from './prompts.ts';
import { RateLimit } from './rate-limit.ts';
import { newSecret, secretsEqual } from './secrets.ts';
import {
  applyReport,
  endWaiting,
  getLiveSession,
  listHistory,
  listSessions,
  listStaleSessions,
  setWaiting,
} from './sessions.ts';
import {
  getReviewSettings,
  getSessionSettings,
  saveReviewSettings,
  saveSessionSettings,
} from './settings.ts';
import { INSTALLED_HEADER, isBehind, LATEST_HEADER, PLUGIN_HEADER } from './version.ts';

export interface AppOptions {
  /** GitHub sign-in. Without it the server is open and everything belongs to `local`: for local
   * development only (index.ts refuses to run that way in production). */
  github?: GitHubAuth;
  /** Where the dashboard is reached, e.g. `https://joc.marcswilson.com`. */
  publicUrl: string;
  /** Aborted when the server shuts down: live streams end so browsers reconnect elsewhere. */
  shutdown?: AbortSignal;
  /** The plugin version machines should run (index.ts reads it from the plugin's manifest). */
  pluginVersion: PluginVersion;
  /** Names the dashboard build this server serves, so an open tab can tell it was replaced. */
  build?: string;
  /** Where its live streams hear updates: this process's bus, unless a test stands in another. */
  bus?: Bus;
}

/** How a request proved who it is: a browser session, a machine's token, or open local dev. */
type Via = 'session' | 'device' | 'open';

/** `device` is the public id of the machine whose token the request came with. */
export type Env = { Variables: { owner: Owner; via: Via; device?: string } };

const LOCAL = ownerFrom('local');

/** The API, without serving: index.ts serves it, and tests call `app.request` directly. */
export function createApp({
  github,
  publicUrl,
  pluginVersion,
  build,
  shutdown = new AbortController().signal,
  bus = processBus,
}: AppOptions): Hono<Env> {
  const app = new Hono<Env>();

  // In memory, as the server runs one replica.
  const linkStarts = new RateLimit(10, 10 * 60_000);
  const linkPolls = new RateLimit(600, 10 * 60_000);
  const approvals = new RateLimit(10, 10 * 60_000);
  // Generous: a session's backlog can carry a few dozen screenshots at once.
  const uploads = new RateLimit(600, 10 * 60_000);

  /** A version the request names in `header`; undefined for a browser, or a plugin too old to. */
  const versionIn = (c: Context, header: string) => {
    const sent = PluginVersion.safeParse(c.req.header(header));
    return sent.success ? sent.data : undefined;
  };
  /** The version the requesting plugin runs. */
  const pluginOf = (c: Context) => versionIn(c, PLUGIN_HEADER);

  async function identify(
    c: Context,
  ): Promise<{ owner: Owner; via: Via; device?: string } | undefined> {
    if (!github) return { owner: LOCAL, via: 'open' };
    const token = bearerToken(c);
    if (token) {
      const sent = { plugin: pluginOf(c), installed: versionIn(c, INSTALLED_HEADER) };
      const resolved = await resolveDeviceToken(token, sent);
      return resolved && { owner: resolved.owner, via: 'device', device: resolved.device };
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

  // A plugin behind the version this server ships with hears which one, on every answer, so it
  // can tell the person. Nothing is refused for it: an old plugin keeps working as it did.
  app.use('/api/*', async (c, next) => {
    await next();
    const sent = pluginOf(c);
    if (sent && isBehind(sent, pluginVersion)) c.header(LATEST_HEADER, pluginVersion);
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
    if (who.device) c.set('device', who.device);
    return next();
  });

  app.get('/api/auth', async (c) => {
    const who = await identify(c);
    const user = who && who.via !== 'open' ? await getUser(who.owner) : undefined;
    return c.json({ required: !!github, signedIn: !!who, user } satisfies AuthStatus);
  });

  app.get('/api/version', (c) => c.json({ plugin: pluginVersion, build } satisfies ServerVersion));

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
  /** Taken from a machine's plugin only, never a browser. */
  const machine = (c: Context<Env>) => c.get('via') !== 'session';
  /** A report for a session the owner deleted: taken, so the plugin moves on, and dropped. */
  const ignored = (c: Context<Env>) => c.json({ ignored: true }, 200);

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
    const owner = c.get('owner');
    const stale = await listStaleSessions(owner, pluginVersion);
    return c.json(await listDevices(owner, pluginVersion, stale));
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
    if (await isDeleted(c.get('owner'), parsed.data.sessionId)) return ignored(c);
    // Which copy of the plugin the session runs, from the request: every plugin that names its
    // version does so in the header, so even a session that hasn't reloaded in a while tells.
    const session = await applyReport(c.get('owner'), parsed.data, {
      plugin: pluginOf(c),
      device: c.get('device'),
    });
    // 202 for a stale report: accepted, but a newer one already won.
    return session ? c.json(session) : c.body(null, 202);
  });

  app.get('/api/sessions', async (c) => c.json(await listSessions(c.get('owner'))));

  app.get('/api/history', async (c) => c.json(await listHistory(c.get('owner'))));

  // How long quiet and ended sessions stay on the live list: the person's choice, not a machine's.
  app.get('/api/settings/sessions', async (c) => {
    if (!person(c)) return c.json({ error: 'Forbidden' }, 403);
    return c.json(await getSessionSettings(c.get('owner')));
  });

  app.put('/api/settings/sessions', async (c) => {
    if (!person(c)) return c.json({ error: 'Forbidden' }, 403);
    const parsed = SessionSettings.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    await saveSessionSettings(c.get('owner'), parsed.data);
    return c.json(parsed.data);
  });

  // Pins, folds and the notifications switch: the person's own, never a machine's.
  app.get('/api/prefs', async (c) => {
    if (!person(c)) return c.json({ error: 'Forbidden' }, 403);
    return c.json(await getPrefs(c.get('owner')));
  });

  app.patch('/api/prefs', bodyLimit({ maxSize: 512 * 1024 }), async (c) => {
    if (!person(c)) return c.json({ error: 'Forbidden' }, 403);
    const parsed = PrefsPatch.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    return c.json(await patchPrefs(c.get('owner'), parsed.data));
  });

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

  // ── Alerts: raised by the server from reports, kept to look back on ─────────

  app.get('/api/alerts', async (c) => c.json(await listAlerts(c.get('owner'))));

  app.post('/api/alerts/read', async (c) => {
    const parsed = AlertIdsRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    await readAlerts(c.get('owner'), parsed.data.ids);
    return c.body(null, 204);
  });

  app.post('/api/alerts/read-all', async (c) => {
    await readAlerts(c.get('owner'));
    return c.body(null, 204);
  });

  app.post('/api/alerts/clear', async (c) => {
    const parsed = AlertIdsRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    await clearAlerts(c.get('owner'), parsed.data.ids);
    return c.body(null, 204);
  });

  app.post('/api/alerts/clear-all', async (c) => {
    await clearAlerts(c.get('owner'));
    return c.body(null, 204);
  });

  app.post('/api/messages', async (c) => {
    const parsed = MessagesReport.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    if (await isDeleted(c.get('owner'), parsed.data.sessionId)) return ignored(c);
    return c.json({ added: await addMessages(c.get('owner'), parsed.data) });
  });

  app.get('/api/sessions/:id/messages', async (c) =>
    c.json(await listMessages(c.get('owner'), c.req.param('id'))),
  );

  // A background subagent's own steps, from its transcript.
  app.get('/api/sessions/:id/tasks/:task/messages', async (c) =>
    c.json(await listMessages(c.get('owner'), c.req.param('id'), { task: c.req.param('task') })),
  );

  app.post('/api/changes', async (c) => {
    const parsed = ChangesReport.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    if (await isDeleted(c.get('owner'), parsed.data.sessionId)) return ignored(c);
    // 202 for a stale report: accepted, but a newer diff already won.
    return (await saveChanges(c.get('owner'), parsed.data))
      ? c.json({ ok: true })
      : c.body(null, 202);
  });

  app.get('/api/sessions/:id/changes', async (c) => {
    const changes = await getChanges(c.get('owner'), c.req.param('id'));
    return changes ? c.json(changes) : c.json({ error: 'No changes reported yet' }, 404);
  });

  // The session's slash commands, from its plugin, for the composer's suggestions.
  app.post('/api/commands', async (c) => {
    const parsed = CommandsReport.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    if (await isDeleted(c.get('owner'), parsed.data.sessionId)) return ignored(c);
    // 202 for a stale report: accepted, but a newer list already won.
    return (await saveCommands(c.get('owner'), parsed.data))
      ? c.json({ ok: true })
      : c.body(null, 202);
  });

  app.get('/api/sessions/:id/commands', async (c) => {
    const commands = await getCommands(c.get('owner'), c.req.param('id'));
    return commands ? c.json(commands) : c.json({ error: 'No commands reported yet' }, 404);
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

  // ── Answers: a question or permission request answered from the dashboard ──
  // The session's plugin says what it waits on and holds a poll open for the answer, while Claude
  // Code asks in the terminal too. The first answer wins; the plugin says when the wait is over.

  // From the session's plugin: what it waits on now. A browser can't make a session wait.
  app.post('/api/sessions/:id/waiting', async (c) => {
    if (c.get('via') === 'session') return c.json({ error: 'Forbidden' }, 403);
    const parsed = Waiting.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    if (await isDeleted(c.get('owner'), c.req.param('id'))) return ignored(c);
    return (await setWaiting(c.get('owner'), c.req.param('id'), parsed.data))
      ? c.body(null, 204)
      : c.json({ error: 'No such session' }, 404);
  });

  // From the session's plugin: the wait is over, answered here, in Claude Code, or neither.
  app.post('/api/sessions/:id/waiting/:waitingId/done', async (c) => {
    if (c.get('via') === 'session') return c.json({ error: 'Forbidden' }, 403);
    const parsed = WaitingDone.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const owner = c.get('owner');
    const { id, waitingId } = c.req.param();
    const ended = await endWaiting(owner, id, waitingId, parsed.data.by);
    // An answer nobody took came too late: it's dropped.
    await dropAnswer(owner, id, waitingId);
    return ended ? c.body(null, 204) : c.json({ error: 'No such wait' }, 404);
  });

  // From the dashboard: answer what the session waits on. Only a person answers, never a machine.
  app.post('/api/sessions/:id/answers', async (c) => {
    if (c.get('via') === 'device') return c.json({ error: 'Forbidden' }, 403);
    const parsed = AnswerRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const owner = c.get('owner');
    const { waitingId, answer } = parsed.data;
    const session = await getLiveSession(owner, c.req.param('id'));
    if (!session) return c.json({ error: 'No such live session' }, 404);
    const { waiting, answered } = session;
    if (waiting?.id !== waitingId) {
      const by = answered?.id === waitingId ? answered.by : undefined;
      const refused: AnswerRefused = { error: 'It was already answered', answeredBy: by };
      return c.json(refused, 409);
    }
    if (!answerFits(waiting, answer)) return c.json({ error: "That doesn't answer it" }, 400);
    if (!(await saveAnswer(owner, session.id, waitingId, answer))) {
      const refused: AnswerRefused = { error: 'It was already answered', answeredBy: 'joc' };
      return c.json(refused, 409);
    }
    return c.body(null, 202);
  });

  // From the session's plugin: take the answer, waiting up to `waitMs` for one.
  app.post('/api/sessions/:id/answers/claim', async (c) => {
    if (c.get('via') === 'session') return c.json({ error: 'Forbidden' }, 403);
    const parsed = AnswerClaim.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const { waitingId, waitMs = 0 } = parsed.data;
    const answer = await waitForAnswer(
      c.get('owner'),
      c.req.param('id'),
      waitingId,
      waitMs,
      AbortSignal.any([c.req.raw.signal, shutdown]),
    );
    return c.json({ answer: answer ?? null } satisfies ClaimedAnswer);
  });

  // ── New sessions, started beside a running one ─────────────────────────────

  // The owner's recent launches; with repo and number, the ones reviewing that PR.
  app.get('/api/launches', async (c) => {
    const repo = c.req.query('repo');
    const number = Number(c.req.query('number'));
    if (repo === undefined) return c.json(await listLaunches(c.get('owner')));
    if (!repo || !Number.isInteger(number) || number < 1) {
      return c.json({ error: 'Name the PR with repo and number' }, 400);
    }
    return c.json(await listLaunches(c.get('owner'), { repo, number }));
  });

  // From the dashboard: start a new session from one of the owner's live sessions, which has a
  // folder to start it in. A review needs one on the PR's repo, and runs the owner's review
  // instructions.
  app.post('/api/launches', async (c) => {
    const owner = c.get('owner');
    const parsed = LaunchRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const { from, review } = parsed.data;
    const session = await getLiveSession(owner, from);
    if (!session) return c.json({ error: 'No such live session' }, 400);
    if (session.state === 'offline') return c.json({ error: 'That session is offline' }, 400);
    if (review && session.repo !== review.repo) {
      return c.json({ error: `That session isn't on ${review.repo}` }, 400);
    }
    const prompt = review
      ? reviewPrompt(review, (await getReviewSettings(owner)).instructions)
      : parsed.data.prompt || undefined;
    return c.json(await createLaunch(owner, { from, repo: session.repo, prompt, review }), 201);
  });

  app.get('/api/settings/review', async (c) => c.json(await getReviewSettings(c.get('owner'))));

  app.put('/api/settings/review', async (c) => {
    const parsed = ReviewSettings.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    await saveReviewSettings(c.get('owner'), parsed.data);
    return c.json(parsed.data);
  });

  // From a session's plugin: the new sessions to start beside it. A browser can't start one.
  app.post('/api/sessions/:id/launches/claim', async (c) => {
    if (c.get('via') === 'session') return c.json({ error: 'Forbidden' }, 403);
    return c.json({ launches: await claimLaunches(c.get('owner'), c.req.param('id')) });
  });

  app.post('/api/launches/:id/result', async (c) => {
    if (c.get('via') === 'session') return c.json({ error: 'Forbidden' }, 403);
    const parsed = LaunchResult.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    return (await finishLaunch(c.get('owner'), c.req.param('id'), parsed.data))
      ? c.body(null, 204)
      : c.json({ error: 'No such launch' }, 404);
  });

  // ── Deleting ended sessions, on their machine and in JOC ───────────────────

  // The owner's deletes of the last day, for the dashboard to show how each stands.
  app.get('/api/deletes', async (c) => {
    if (!person(c)) return c.json({ error: 'Forbidden' }, 403);
    return c.json(await listDeletes(c.get('owner')));
  });

  // From the dashboard: delete these ended sessions. Only a person deletes, never a machine.
  app.post('/api/deletes', async (c) => {
    if (!person(c)) return c.json({ error: 'Forbidden' }, 403);
    const parsed = DeleteRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const outcome = await requestDeletes(c.get('owner'), parsed.data.sessionIds);
    if (outcome.ok) return c.json(outcome.deletions, 202);
    const [first] = outcome.refused;
    const error = outcome.refused.length === 1 && first ? first.reason : "Some can't be deleted";
    return c.json({ error, sessions: outcome.refused } satisfies DeleteRefused, 400);
  });

  // From a machine's plugin: the deletes waiting for that machine. A browser can't take them.
  app.post('/api/deletes/claim', async (c) => {
    if (!machine(c)) return c.json({ error: 'Forbidden' }, 403);
    const parsed = DeleteClaim.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const deletes = await claimDeletes(c.get('owner'), parsed.data.machine, c.get('device'));
    return c.json({ deletes } satisfies ClaimedDeletes);
  });

  app.post('/api/deletes/:id/result', async (c) => {
    if (!machine(c)) return c.json({ error: 'Forbidden' }, 403);
    const parsed = DeleteResult.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    return (await finishDelete(c.get('owner'), c.req.param('id'), parsed.data))
      ? c.body(null, 204)
      : c.json({ error: 'No such delete' }, 404);
  });

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
        // Some updates may have been lost on the way from another server process: the browser
        // reloads everything from a new snapshot.
        const resend = () =>
          listSessions(owner)
            .then((sessions) => publish({ type: 'snapshot', sessions }))
            .catch((error: unknown) => console.error('Resending a snapshot failed:', error));
        const unsubscribeAll = bus.subscribe(owner, (message) => {
          if (message.type === 'missed') void resend();
          else publish(message);
        });
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

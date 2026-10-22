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
  type ClaimedResumes,
  CommandsReport,
  DeleteClaim,
  type DeleteRefused,
  DeleteRequest,
  DeleteResult,
  DeviceApproveRequest,
  DeviceStartRequest,
  DeviceTokenRequest,
  type GitHubConnection,
  type GitHubConnectionState,
  GitHubReport,
  type GitHubSignInNote,
  ImageId,
  LaunchRequest,
  LaunchResult,
  MAX_IMAGE_BYTES,
  MessagesReport,
  PluginVersion,
  PrefsPatch,
  ProblemsReport,
  PromptHandoff,
  type PromptQueued,
  PromptRequest,
  ResumeClaim,
  ResumeRequest,
  ResumeResult,
  type ReviewedPullRequest,
  ReviewSettings,
  reviewPrompt,
  type ServerVersion,
  type SessionChanges,
  type SessionPrompts,
  SessionReport,
  SessionStatusReport,
  StoredSessionSettings,
  type StreamEvent,
  settleSessionSettings,
  teamDrafts,
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
  setInstallReturn,
  setOAuthCookies,
  setSessionCookie,
  takeInstallReturn,
  takeOAuthCookies,
  withNote,
} from './auth.ts';
import { type Bus, bus as processBus } from './bus.ts';
import { getChanges, saveChanges } from './changes.ts';
import { getCommands, saveCommands } from './commands.ts';
import { claimDeletes, finishDelete, isDeleted, listDeletes, requestDeletes } from './deletes.ts';
import type { GitHubAuth } from './github.ts';
import type { GitHubAppAbout } from './github-app.ts';
import { getGitHub, pullDetails, saveGitHub } from './github-data.ts';
import {
  backfillOwner,
  forgetOwnerCoverage,
  installationAccounts,
  isCovered,
  noteInstallations,
  readReviewedPull,
  reviewedPull,
} from './github-events.ts';
import { firstDelivery, verifySignature, type Webhooks } from './github-webhook.ts';
import {
  approveLink,
  createWebSession,
  endWebSession,
  type GitHubPerson,
  getUser,
  githubPerson,
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
import { addMessages, listMessages, movesTeam, teamItems } from './messages.ts';
import { getOperations } from './operations.ts';
import { type Owner, ownerFrom } from './owner.ts';
import { getPrefs, patchPrefs } from './prefs.ts';
import { listProblems, saveProblems } from './problems.ts';
import { cancelPrompt, claimPrompts, handOffPrompt, listPrompts, queuePrompt } from './prompts.ts';
import { RateLimit } from './rate-limit.ts';
import { cancelResume, claimResumes, finishResume, listResumes, requestResume } from './resumes.ts';
import { reviewChanges } from './review-diff.ts';
import { newSecret, secretsEqual } from './secrets.ts';
import { getStatus, saveStatus } from './session-status.ts';
import {
  applyReport,
  endWaiting,
  getLiveSession,
  getSessionReview,
  listHistory,
  listSessions,
  listStaleSessions,
  markReview,
  setTeam,
  setTeamFolder,
  setWaiting,
} from './sessions.ts';
import {
  getReviewSettings,
  getSessionSettings,
  saveReviewSettings,
  saveSessionSettings,
} from './settings.ts';
import {
  GITHUB_SOURCE_HEADER,
  INSTALLED_HEADER,
  isBehind,
  LATEST_HEADER,
  PLUGIN_HEADER,
} from './version.ts';

/** The first plugin that says when Claude Code took a prompt it claimed. */
const HANDOFF_FROM = '0.12.1';

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
  /** The JOC GitHub App's webhooks. Without them, GitHub data comes from each machine's plugin. */
  webhooks?: Webhooks;
  /** The App's slug, when the server can't read it from GitHub (no App id and key). */
  appSlug?: string;
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
  webhooks,
  appSlug,
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

  /**
   * Where the person stands with the App: signed in before it (no record of an App sign-in) is
   * `reconnect`, whatever webhooks may have granted since, as JOC hasn't seen their own
   * installations.
   */
  async function connectionState(
    owner: Owner,
    me: GitHubPerson | undefined,
  ): Promise<GitHubConnectionState> {
    if (!github || !webhooks) return 'off';
    if (!me?.appSignInAt) return 'reconnect';
    return (await isCovered(owner)) ? 'covered' : 'install';
  }

  /** The App's slug and name: read from GitHub with its JWT (once), or the configured slug. */
  async function appAbout(): Promise<GitHubAppAbout | undefined> {
    // GitHub unreachable: fall back to the configured slug below.
    const read = await webhooks?.context.api?.about().catch(() => undefined);
    return read ?? (appSlug ? { slug: appSlug, name: appSlug } : undefined);
  }

  // Off to GitHub to install the App, remembering the page to come back to: GitHub returns to
  // the callback, without a state of ours, once it's installed (or requested).
  app.get('/auth/github/install', async (c) => {
    const about = github && webhooks ? await appAbout() : undefined;
    const returnTo = safeReturnPath(c.req.query('return'));
    if (!about) return c.redirect(withNote(returnTo, 'failed'));
    setInstallReturn(c, returnTo);
    return c.redirect(`https://github.com/apps/${about.slug}/installations/new`);
  });

  app.get('/auth/github/callback', async (c) => {
    if (!github) return c.redirect('/');
    const query = (name: string) => c.req.query(name);
    // Back from installing the App, which authorizes without a state of ours: sign in afresh,
    // which GitHub answers at once for someone who just authorized, and which reads the new
    // installation. Its code is never taken: without our state it could be anyone's.
    const setup = query('setup_action');
    if (setup && !query('state')) {
      const back = takeInstallReturn(c);
      const target = setup === 'request' ? withNote(back, 'requested') : back;
      return c.redirect(`/auth/github?return=${encodeURIComponent(target)}`);
    }
    const { state, returnTo } = takeOAuthCookies(c);
    const code = query('code');
    // Anything short of a sign-in goes back to the page it started from, saying why. A session
    // the browser already has is kept, so a failed reconnect never signs anyone out.
    const back = (note: GitHubSignInNote) => c.redirect(withNote(returnTo, note));
    // The state ties the callback to a sign-in this browser started: no forged callbacks.
    const ours = !!state && secretsEqual(query('state'), state);
    if (ours && query('error') === 'access_denied') return back('denied');
    if (!code || !ours) return back('expired');
    const profile = await github.profileFor(code);
    if (!profile) return back('failed');
    const owner = await signInGitHubUser(profile);
    if (profile.seen) await noteInstallations(profile.seen);
    forgetOwnerCoverage(owner);
    // The new session replaces the one this browser had, if any.
    const previous = sessionSecret(c);
    setSessionCookie(c, await createWebSession(owner));
    if (previous) await endWebSession(previous);
    // Their pull requests, read once through the App; webhooks keep them current after.
    if (webhooks) {
      const { context } = webhooks;
      webhooks.run('A sign-in backfill', () => backfillOwner(context, owner));
    }
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
  // GitHub's webhook proves itself with its signature instead.
  const open = ['/api/auth', '/api/devices/start', '/api/devices/token', '/api/github/webhook'];
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
    await next();
    // A machine whose person the App covers leaves GitHub to it: no `gh` reads.
    if (webhooks && who.via === 'device' && (await isCovered(who.owner))) {
      c.header(GITHUB_SOURCE_HEADER, 'app');
    }
  });

  app.get('/api/auth', async (c) => {
    const who = await identify(c);
    const user = who && who.via !== 'open' ? await getUser(who.owner) : undefined;
    const signedIn = { required: !!github, signedIn: !!who, user };
    if (!who) return c.json(signedIn satisfies AuthStatus);
    const state = await connectionState(who.owner, await githubPerson(who.owner));
    return c.json({ ...signedIn, github: state } satisfies AuthStatus);
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
    // A tab from before the keep times changed may send one no longer offered: it's settled to
    // the nearest one, as a stored one is.
    const parsed = StoredSessionSettings.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const value = settleSessionSettings(parsed.data);
    await saveSessionSettings(c.get('owner'), value);
    return c.json(value);
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

  // ── GitHub: from the App's webhooks, or as the person's plugin reads it through `gh` ──

  app.post('/api/github/webhook', bodyLimit({ maxSize: 25 * 1024 * 1024 }), async (c) => {
    if (!webhooks) return c.json({ error: 'No GitHub App here' }, 404);
    const body = await c.req.text();
    if (!verifySignature(webhooks.secret, body, c.req.header('x-hub-signature-256'))) {
      return c.json({ error: 'Bad signature' }, 401);
    }
    const event = c.req.header('x-github-event');
    const delivery = c.req.header('x-github-delivery');
    if (!event || !delivery) return c.json({ error: 'Not a GitHub delivery' }, 400);
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return c.json({ error: 'Not JSON' }, 400);
    }
    if (!(await firstDelivery(delivery, event))) return c.json({ duplicate: true }, 200);
    webhooks.enqueue(event, payload);
    return c.body(null, 202);
  });

  app.post('/api/github', async (c) => {
    const parsed = GitHubReport.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    // An older plugin still reads for a person the App covers: taken, and dropped.
    if (webhooks && (await isCovered(c.get('owner')))) return c.body(null, 202);
    // 202 for a stale report: accepted, but a newer one already won.
    return (await saveGitHub(c.get('owner'), parsed.data))
      ? c.json({ ok: true })
      : c.body(null, 202);
  });

  app.get('/api/github', async (c) => c.json(await getGitHub(c.get('owner'))));

  // Every piece of work in flight: the owner's sessions joined to their pull requests (#111).
  // Its live updates are the session and github events the stream already sends.
  app.get('/api/operations', async (c) => c.json(await getOperations(c.get('owner'))));

  // How the person's GitHub reaches JOC, and what's left to do: reconnect, or install the App.
  app.get('/api/github/connection', async (c) => {
    if (!person(c)) return c.json({ error: 'Forbidden' }, 403);
    const owner = c.get('owner');
    if (!github || !webhooks)
      return c.json({ state: 'off', accounts: [] } satisfies GitHubConnection);
    const [me, about] = await Promise.all([githubPerson(owner), appAbout()]);
    const reached = await installationAccounts(me?.installations ?? []);
    const state = await connectionState(owner, me);
    return c.json({
      state,
      appName: about?.name,
      signedInAt: me?.appSignInAt?.toISOString(),
      accounts: reached.map(({ id, account, suspended }) => ({
        login: account.login,
        type: account.type,
        suspended,
        manageUrl:
          account.type === 'Organization'
            ? `https://github.com/organizations/${encodeURIComponent(account.login)}/settings/installations/${id}`
            : `https://github.com/settings/installations/${id}`,
      })),
      installUrl: about ? `https://github.com/apps/${about.slug}/installations/new` : undefined,
    } satisfies GitHubConnection);
  });

  // GitHub's notifications inbox is gone (mentions and comments are alerts now). Plugins before
  // 0.13.0 still send it and ask for threads to mark read: answered, and nothing kept.
  app.post('/api/notifications', (c) => c.json({ ignored: true }, 200));
  app.post('/api/notifications/reads/claim', (c) => c.json({ ids: [] }));

  // ── Alerts: raised by the server from reports, kept to look back on ─────────
  // Reading and clearing are safe to repeat, and answer with the list after the change.

  app.get('/api/alerts', async (c) => c.json(await listAlerts(c.get('owner'))));

  app.post('/api/alerts/read', async (c) => {
    const parsed = AlertIdsRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    return c.json(await readAlerts(c.get('owner'), parsed.data.ids));
  });

  app.post('/api/alerts/read-all', async (c) => c.json(await readAlerts(c.get('owner'))));

  app.post('/api/alerts/clear', async (c) => {
    const parsed = AlertIdsRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    return c.json(await clearAlerts(c.get('owner'), parsed.data.ids));
  });

  app.post('/api/alerts/clear-all', async (c) => c.json(await clearAlerts(c.get('owner'))));

  app.post('/api/messages', async (c) => {
    const parsed = MessagesReport.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const owner = c.get('owner');
    const { sessionId, teammate } = parsed.data;
    if (await isDeleted(owner, sessionId)) return ignored(c);
    const fresh = await addMessages(owner, parsed.data);
    if (teammate) await setTeamFolder(owner, sessionId, teammate);
    // New word on a teammate: work its team out again from the conversation.
    if (fresh.some(movesTeam)) {
      await setTeam(owner, sessionId, teamDrafts(await teamItems(owner, sessionId)));
    }
    return c.json({ added: fresh.length });
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

  // A review session shows the pull request it reviews, never the branch in its folder.
  app.get('/api/sessions/:id/changes', async (c) => {
    const owner = c.get('owner');
    const review = await getSessionReview(owner, c.req.param('id'));
    if (review) {
      return c.json(
        (await reviewChanges(webhooks?.context, owner, review)) satisfies SessionChanges,
      );
    }
    const changes = await getChanges(owner, c.req.param('id'));
    return changes
      ? c.json(changes satisfies SessionChanges)
      : c.json({ error: 'No changes reported yet' }, 404);
  });

  // The pull request a review session reviews: the App's copy when it covers the owner (read
  // once from GitHub if no event brought it yet), else their plugin's last read of it.
  app.get('/api/sessions/:id/review', async (c) => {
    const owner = c.get('owner');
    const review = await getSessionReview(owner, c.req.param('id'));
    if (!review) return c.json({ error: 'Not a review session' }, 404);
    const { repo, number } = review;
    let found: Omit<ReviewedPullRequest, 'review'> | undefined;
    if (webhooks && (await isCovered(owner))) {
      found = await reviewedPull(owner, repo, number);
      if (!found && webhooks.context.api) {
        const { context } = webhooks;
        await webhooks.run('A review read', () => readReviewedPull(context, owner, repo, number));
        found = await reviewedPull(owner, repo, number);
      }
    }
    found ??= await pullDetails(owner, repo, number);
    return c.json({ review, ...found } satisfies ReviewedPullRequest);
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

  // What the session runs on (version, model, MCP servers), from its plugin, for its Status view.
  app.post('/api/status', async (c) => {
    const parsed = SessionStatusReport.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    if (await isDeleted(c.get('owner'), parsed.data.sessionId)) return ignored(c);
    // 202 for a stale report: accepted, but a newer one already won.
    return (await saveStatus(c.get('owner'), parsed.data))
      ? c.json({ ok: true })
      : c.body(null, 202);
  });

  app.get('/api/sessions/:id/status', async (c) => {
    const status = await getStatus(c.get('owner'), c.req.param('id'));
    return status ? c.json(status) : c.json({ error: 'No status reported yet' }, 404);
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
    return c.json({ id } satisfies PromptQueued, 201);
  });

  // Where the session's prompts from the dashboard stand: in JOC, with Claude Code, or failed.
  app.get('/api/sessions/:id/prompts', async (c) =>
    c.json({
      prompts: await listPrompts(c.get('owner'), c.req.param('id')),
    } satisfies SessionPrompts),
  );

  // From the dashboard: withdraw a prompt the plugin hasn't taken yet.
  app.delete('/api/sessions/:id/prompts/:prompt', async (c) => {
    if (c.get('via') === 'device') return c.json({ error: 'Forbidden' }, 403);
    const done = await cancelPrompt(c.get('owner'), c.req.param('id'), c.req.param('prompt'));
    if (done === 'missing') return c.json({ error: 'No such prompt' }, 404);
    if (done === 'taken') return c.json({ error: "Claude Code has it; JOC can't change it" }, 409);
    return c.body(null, 204);
  });

  // From the session's plugin: take the prompts waiting for it. A plugin from 0.12.1 on then
  // says whether Claude Code took each one (the handoff below).
  app.post('/api/sessions/:id/prompts/claim', async (c) => {
    const sent = pluginOf(c);
    const reports = !!sent && !isBehind(sent, HANDOFF_FROM);
    return c.json({
      prompts: await claimPrompts(c.get('owner'), c.req.param('id'), { reports }),
    });
  });

  app.post('/api/sessions/:id/prompts/:prompt/handoff', async (c) => {
    if (c.get('via') === 'session') return c.json({ error: 'Forbidden' }, 403);
    const parsed = PromptHandoff.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const found = await handOffPrompt(
      c.get('owner'),
      c.req.param('id'),
      c.req.param('prompt'),
      parsed.data,
    );
    return found ? c.json({ ok: true }) : c.json({ error: 'No such prompt' }, 404);
  });

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
    const owner = c.get('owner');
    const launch = await finishLaunch(owner, c.req.param('id'), parsed.data);
    if (!launch) return c.json({ error: 'No such launch' }, 404);
    // The session it started reviews the launch's PR, once it reported.
    const { sessionId } = parsed.data;
    if (parsed.data.ok && sessionId && launch.review) {
      await markReview(owner, sessionId, launch.review);
    }
    return c.body(null, 204);
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

  // ── Resuming ended sessions, on a machine that has them ───────────────────

  // The owner's resumes of the last day, for the dashboard to show how each stands.
  app.get('/api/resumes', async (c) => {
    if (!person(c)) return c.json({ error: 'Forbidden' }, 403);
    return c.json(await listResumes(c.get('owner')));
  });

  // From the dashboard: resume this ended session. Only a person resumes, never a machine.
  app.post('/api/resumes', async (c) => {
    if (!person(c)) return c.json({ error: 'Forbidden' }, 403);
    const parsed = ResumeRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const { sessionId, machine } = parsed.data;
    const outcome = await requestResume(c.get('owner'), sessionId, machine);
    return outcome.ok ? c.json(outcome.resume, 202) : c.json({ error: outcome.reason }, 400);
  });

  // From the dashboard: withdraw a resume no machine has taken yet.
  app.post('/api/resumes/:id/cancel', async (c) => {
    if (!person(c)) return c.json({ error: 'Forbidden' }, 403);
    return (await cancelResume(c.get('owner'), c.req.param('id')))
      ? c.body(null, 204)
      : c.json({ error: 'It already started, or there is no such resume' }, 409);
  });

  // From a machine's plugin: the resumes waiting for that machine. A browser can't take them.
  app.post('/api/resumes/claim', async (c) => {
    if (!machine(c)) return c.json({ error: 'Forbidden' }, 403);
    const parsed = ResumeClaim.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    const resumes = await claimResumes(c.get('owner'), parsed.data.machine, c.get('device'));
    return c.json({ resumes } satisfies ClaimedResumes);
  });

  app.post('/api/resumes/:id/result', async (c) => {
    if (!machine(c)) return c.json({ error: 'Forbidden' }, 403);
    const parsed = ResumeResult.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues }, 400);
    return (await finishResume(c.get('owner'), c.req.param('id'), parsed.data))
      ? c.body(null, 204)
      : c.json({ error: 'No such resume' }, 404);
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
        // A browser that goes away ends the pause between pings at once, so no timer outlives it.
        const gone = new AbortController();
        stream.onAbort(() => {
          unsubscribeAll();
          gone.abort();
        });
        const quiet = AbortSignal.any([shutdown, gone.signal]);

        try {
          await send({ type: 'snapshot', sessions: await listSessions(owner) });
          for (const event of pending) await send(event);
          ready = true;

          // Keeps idle connections open through proxies, and lets the browser tell a quiet
          // stream from a dead one (it reconnects after STREAM_TIMEOUT_MS of silence). On
          // shutdown the stream ends, and the browser reconnects to the server taking over,
          // which starts it with a fresh snapshot.
          while (!stream.aborted && !shutdown.aborted) {
            // Rejects when the shutdown or the browser leaving cuts the pause short; the loop
            // condition handles that.
            await sleep(15_000, undefined, { signal: quiet }).catch(() => undefined);
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

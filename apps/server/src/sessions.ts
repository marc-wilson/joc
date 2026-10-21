import { getDb } from '@joc/db';
import {
  type AnsweredBy,
  DROP_AFTER_MS,
  type DropAfter,
  type HistorySession,
  type PluginVersion,
  QUIET_AFTER_MS,
  type ReviewOutcome,
  reviewOfPrompt,
  reviewOutcome,
  type Session,
  type SessionReport,
  type SessionReview,
  type StaleSession,
  type Waiting,
} from '@joc/protocol';
import { alertOnSession } from './alerts.ts';
import { publish } from './bus.ts';
import { launchedReview } from './launches.ts';
import { countMessages } from './messages.ts';
import { type Owner, sessionKey } from './owner.ts';
import { getSessionSettings } from './settings.ts';
import { isBehind } from './version.ts';

interface SessionDoc {
  /** `owner/sessionId` (see owner.ts). */
  _id: string;
  owner: string;
  sessionId: string;
  title?: string;
  name?: string;
  repo: string;
  branch?: string;
  /** The linked worktree it works in; unset in the repo's main checkout. */
  worktree?: string;
  state: Session['state'];
  activity?: string;
  contextLeft?: number;
  machine?: string;
  model?: string;
  cwd?: string;
  /** The plugin version the session's latest report ran: the copy the session loaded. */
  plugin?: string;
  /** The public id of the machine whose token sent the latest report; unset in open local dev. */
  device?: string;
  createdAt: Date;
  updatedAt: Date;
  /** `at` of the last report with a state applied. */
  reportedAt: number;
  /** The state before the last report, so the report's alert (alerts.ts) knows what changed. */
  previousState?: Session['state'];
  /** `at` of the report that started its current (or last) turn: working after not working. */
  turnStartedAt?: number;
  /** What it waits on you for, while its plugin takes answers from the dashboard. */
  waiting?: Waiting;
  /** The last wait that ended, and who answered it. */
  answered?: Session['answered'];
  /** What Claude Code last said runs in the background, and when. */
  background?: Session['background'];
  /** The PR it reviews, when JOC's Review button started it (its first prompt can say too). */
  review?: Omit<SessionReview, 'outcome'>;
  /** How its review ended, from the last turn whose closing words said. */
  reviewOutcome?: ReviewOutcome;
}

const sessions = () => getDb().collection<SessionDoc>('sessions');

function toSession({
  _id: _,
  owner: _o,
  sessionId,
  createdAt,
  reportedAt: _r,
  previousState: _p,
  turnStartedAt: _t,
  device: _d,
  updatedAt,
  reportedAt,
  name,
  title,
  review: launched,
  reviewOutcome: outcome,
  ...rest
}: SessionDoc): Session {
  // `title` is the first prompt's first line: a review command names the PR it reviews.
  const review = launched ?? reviewOfPrompt(title, rest.repo);
  return {
    id: sessionId,
    ...rest,
    // Claude Code's own name beats the first-prompt fallback.
    title: name ?? title,
    ...(review ? { review: outcome ? { ...review, outcome } : review } : {}),
    startedAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    ...(reportedAt > 0 ? { activeAt: new Date(reportedAt).toISOString() } : {}),
  };
}

/** The live list's limit, the most recently active, so `never` can't grow it without end. */
const LISTED = 200;

/** Sessions active within `after`, or every one for `never`. */
function activeWithin(after: DropAfter, now: number): { updatedAt?: { $gt: Date } } {
  return after === 'never' ? {} : { updatedAt: { $gt: new Date(now - DROP_AFTER_MS[after]) } };
}

/**
 * The owner's live sessions, in first-seen order so the dashboard never reorders them. An open
 * session syncs every 30s and always shows. One that went quiet or ended drops out after the
 * owner's settings say, which the dashboard reads only when it (re)connects or the settings
 * change: a row never vanishes on its own while someone is looking. They stay in the history.
 */
export async function listSessions(owner: Owner, now = Date.now()): Promise<Session[]> {
  const { quiet, ended } = await getSessionSettings(owner);
  const docs = await sessions()
    .find({
      owner,
      $or: [
        { state: { $ne: 'offline' }, ...activeWithin(quiet, now) },
        { state: 'offline', ...activeWithin(ended, now) },
      ],
    })
    .sort({ updatedAt: -1 })
    .limit(LISTED)
    .toArray();
  return docs.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map(toSession);
}

/** One of the owner's live sessions, or undefined when they have no such live session. */
export async function getLiveSession(
  owner: Owner,
  sessionId: string,
  now = Date.now(),
): Promise<Session | undefined> {
  const { quiet } = await getSessionSettings(owner);
  const doc = await sessions().findOne({
    _id: sessionKey(owner, sessionId),
    ...activeWithin(quiet, now),
  });
  return doc ? toSession(doc) : undefined;
}

/** Every session the owner has had, most recently active first, with message counts. */
export async function listHistory(owner: Owner, limit = 200): Promise<HistorySession[]> {
  const docs = await sessions().find({ owner }).sort({ updatedAt: -1 }).limit(limit).toArray();
  const counts = await countMessages(
    owner,
    docs.map((d) => d.sessionId),
  );
  return docs.map((d) => ({ ...toSession(d), messages: counts.get(d.sessionId) ?? 0 }));
}

/** Who sent a report, from its request rather than its body. */
export interface ReportSender {
  /** The plugin version the reporting session runs, when it said. */
  plugin?: PluginVersion;
  /** The machine whose token sent it. */
  device?: string;
}

/** Applies a report, or returns undefined if a newer one already landed. */
export async function applyReport(
  owner: Owner,
  { sessionId, at, title, background, ...fields }: SessionReport,
  sender: ReportSender = {},
): Promise<Session | undefined> {
  const now = new Date();
  // A turn that ended (or the session going quiet after one) saying how a review went: kept, so
  // the outcome outlasts the session's end.
  const outcome = fields.state === 'idle' ? reviewOutcome(fields.activity) : undefined;
  // $literal keeps reported strings like "$ pnpm test" from being read as field paths. A report
  // that names no plugin version keeps the one stored.
  const set = Object.fromEntries(
    Object.entries({ ...fields, ...sender })
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, { $literal: v }]),
  );
  let doc: SessionDoc | null;
  try {
    doc = await sessions().findOneAndUpdate(
      // Only matches when this report is newer. For a stale report the upsert then tries to
      // insert a duplicate _id, which fails and the report is dropped below.
      { _id: sessionKey(owner, sessionId), reportedAt: { $lt: at } },
      [
        {
          $set: {
            ...set,
            owner: { $literal: owner },
            sessionId: { $literal: sessionId },
            // Read before this stage sets the new state.
            previousState: '$state',
            // A turn starts when it goes to work from rest; waiting on you midway is the same turn.
            ...(fields.state === 'working'
              ? {
                  turnStartedAt: {
                    $cond: [
                      { $in: ['$state', ['working', 'needs']] },
                      { $ifNull: ['$turnStartedAt', at] },
                      at,
                    ],
                  },
                }
              : {}),
            // A report without a state (a sync) keeps the stored one, `idle` for a new session.
            // It doesn't move `reportedAt` either, so a state report that fired before it but
            // lands after it still applies.
            ...(fields.state
              ? { reportedAt: at }
              : {
                  state: { $ifNull: ['$state', 'idle'] },
                  reportedAt: { $ifNull: ['$reportedAt', 0] },
                }),
            updatedAt: now,
            createdAt: { $ifNull: ['$createdAt', now] },
            // A session keeps the title from its first prompt.
            ...(title ? { title: { $ifNull: ['$title', { $literal: title }] } } : {}),
            // Claude Code's list as of this report; a report without one keeps the stored list.
            ...(background
              ? { background: { $literal: { at: new Date(at).toISOString(), tasks: background } } }
              : {}),
            // A session that ended waits on nothing.
            ...(fields.state === 'offline' ? { waiting: '$$REMOVE' } : {}),
            // An empty worktree says the session is back in the repo's main checkout.
            ...(fields.worktree === '' ? { worktree: '$$REMOVE' } : {}),
            ...(outcome ? { reviewOutcome: { $literal: outcome } } : {}),
          },
        },
      ],
      { upsert: true, returnDocument: 'after' },
    );
  } catch (error) {
    if (isDuplicateKey(error)) return undefined;
    throw error;
  }
  if (!doc) throw new Error(`Session ${sessionId} was not saved`);
  // A session JOC's Review button started may report before its plugin says which one it was.
  if (!doc.review && doc.createdAt.getTime() === now.getTime()) {
    const review = await launchedReview(owner, sessionId);
    if (review) doc.review = (await markReview(owner, sessionId, review, false))?.review;
  }
  const session = toSession(doc);
  publish(owner, { type: 'session', session });
  if (fields.state) {
    await alertOnSession(owner, doc.previousState, {
      ...session,
      sessionId,
      turnMs: doc.turnStartedAt === undefined ? undefined : at - doc.turnStartedAt,
    });
  }
  return session;
}

/**
 * Records the PR the owner's session reviews, as the launch that started it says, and tells their
 * dashboards unless `announce` is false. Undefined when the owner has no such session yet.
 */
export async function markReview(
  owner: Owner,
  sessionId: string,
  review: Omit<SessionReview, 'outcome'>,
  announce = true,
): Promise<SessionDoc | undefined> {
  const doc = await sessions().findOneAndUpdate(
    { _id: sessionKey(owner, sessionId), owner },
    { $set: { review: { repo: review.repo, number: review.number, url: review.url } } },
    { returnDocument: 'after' },
  );
  if (!doc) return undefined;
  if (announce) publish(owner, { type: 'session', session: toSession(doc) });
  return doc;
}

/**
 * Records what the session waits on, from its plugin. False when the owner has no such session:
 * a wait is reported after the session's first report.
 */
export async function setWaiting(
  owner: Owner,
  sessionId: string,
  waiting: Waiting,
): Promise<boolean> {
  const doc = await sessions().findOneAndUpdate(
    { _id: sessionKey(owner, sessionId), owner },
    { $set: { waiting } },
    { returnDocument: 'after' },
  );
  if (!doc) return false;
  publish(owner, { type: 'session', session: toSession(doc) });
  return true;
}

/**
 * Ends the session's wait `waitingId`, and says who answered it when someone did. False when the
 * session doesn't wait on it (any more).
 */
export async function endWaiting(
  owner: Owner,
  sessionId: string,
  waitingId: string,
  by?: AnsweredBy,
): Promise<boolean> {
  const doc = await sessions().findOneAndUpdate(
    { _id: sessionKey(owner, sessionId), owner, 'waiting.id': waitingId },
    {
      $unset: { waiting: '' },
      ...(by ? { $set: { answered: { id: waitingId, by } } } : {}),
    },
    { returnDocument: 'after' },
  );
  if (!doc) return false;
  publish(owner, { type: 'session', session: toSession(doc) });
  return true;
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}

/**
 * The owner's live sessions that run a plugin older than `latest`, by the machine that reported
 * them. Only live ones: a session that ended or went quiet can't reload, and doesn't count.
 */
export async function listStaleSessions(
  owner: Owner,
  latest: PluginVersion,
  now = Date.now(),
): Promise<Map<string, StaleSession[]>> {
  const docs = await sessions()
    .find({
      owner,
      state: { $ne: 'offline' },
      updatedAt: { $gt: new Date(now - QUIET_AFTER_MS) },
      device: { $exists: true },
      plugin: { $exists: true },
    })
    .sort({ createdAt: 1 })
    .toArray();
  const stale = new Map<string, StaleSession[]>();
  for (const d of docs) {
    if (!d.device || !d.plugin || !isBehind(d.plugin, latest)) continue;
    const title = d.name ?? d.title;
    const entry = { id: d.sessionId, title, repo: d.repo, state: d.state, plugin: d.plugin };
    stale.set(d.device, [...(stale.get(d.device) ?? []), entry]);
  }
  return stale;
}

/** What deleting or resuming one of the owner's sessions needs to know of it. */
export interface DeletableSession {
  sessionId: string;
  title?: string;
  machine?: string;
  device?: string;
  /** Its folder, where `claude --resume` runs. */
  cwd?: string;
  /** Claude Code ended it (SessionEnd), or it has been quiet long enough to have stopped. */
  ended: boolean;
}

/** The owner's sessions among `ids`, with whether each has ended; ids they don't have are left out. */
export async function deletableSessions(
  owner: Owner,
  ids: string[],
  now = Date.now(),
): Promise<DeletableSession[]> {
  if (!ids.length) return [];
  const docs = await sessions()
    .find({ _id: { $in: ids.map((id) => sessionKey(owner, id)) }, owner })
    .toArray();
  return docs.map((d) => ({
    sessionId: d.sessionId,
    title: d.name ?? d.title,
    machine: d.machine,
    device: d.device,
    cwd: d.cwd,
    ended: d.state === 'offline' || now - d.updatedAt.getTime() > QUIET_AFTER_MS,
  }));
}

/** Deletes one of the owner's sessions from JOC. */
export async function forgetSession(owner: Owner, sessionId: string): Promise<void> {
  await sessions().deleteOne({ _id: sessionKey(owner, sessionId), owner });
}

/** Which of `ids` name sessions the owner has, live or in the history. */
export async function knownSessionIds(owner: Owner, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const found = await sessions()
    .find(
      { _id: { $in: ids.map((id) => sessionKey(owner, id)) }, owner },
      { projection: { sessionId: 1 } },
    )
    .toArray();
  return new Set(found.map((s) => s.sessionId));
}

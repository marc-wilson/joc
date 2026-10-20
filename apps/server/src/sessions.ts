import { EventEmitter } from 'node:events';
import { getDb } from '@joc/db';
import {
  DROP_AFTER_MS,
  type DropAfter,
  type HistorySession,
  type Session,
  type SessionReport,
} from '@joc/protocol';
import { alertOnSession } from './alerts.ts';
import { countMessages } from './messages.ts';
import { type Owner, sessionKey } from './owner.ts';
import { getSessionSettings } from './settings.ts';

interface SessionDoc {
  /** `owner/sessionId` (see owner.ts). */
  _id: string;
  owner: string;
  sessionId: string;
  title?: string;
  name?: string;
  repo: string;
  branch?: string;
  state: Session['state'];
  activity?: string;
  contextLeft?: number;
  machine?: string;
  model?: string;
  cwd?: string;
  createdAt: Date;
  updatedAt: Date;
  /** `at` of the last report with a state applied. */
  reportedAt: number;
  /** The state before the last report, so the report's alert (alerts.ts) knows what changed. */
  previousState?: Session['state'];
}

const sessions = () => getDb().collection<SessionDoc>('sessions');

function toSession({
  _id: _,
  owner: _o,
  sessionId,
  createdAt,
  reportedAt: _r,
  previousState: _p,
  updatedAt,
  name,
  title,
  ...rest
}: SessionDoc): Session {
  return {
    id: sessionId,
    ...rest,
    // Claude Code's own name beats the first-prompt fallback.
    title: name ?? title,
    startedAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
}

/** The live list's limit, the most recently active, so `never` can't grow it without end. */
const LISTED = 200;

const updates = new EventEmitter().setMaxListeners(0);

export function onSessionUpdate(owner: Owner, listener: (session: Session) => void): () => void {
  updates.on(`session:${owner}`, listener);
  return () => updates.off(`session:${owner}`, listener);
}

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

/** Applies a report, or returns undefined if a newer one already landed. */
export async function applyReport(
  owner: Owner,
  { sessionId, at, title, ...fields }: SessionReport,
): Promise<Session | undefined> {
  const now = new Date();
  // $literal keeps reported strings like "$ pnpm test" from being read as field paths.
  const set = Object.fromEntries(
    Object.entries(fields)
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
  const session = toSession(doc);
  updates.emit(`session:${owner}`, session);
  if (fields.state) await alertOnSession(owner, doc.previousState, { ...session, sessionId });
  return session;
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}

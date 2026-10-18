import { EventEmitter } from 'node:events';
import { getDb } from '@joc/db';
import type { Session, SessionReport } from '@joc/protocol';

interface SessionDoc {
  _id: string;
  title?: string;
  repo: string;
  branch?: string;
  state: Session['state'];
  activity?: string;
  contextLeft?: number;
  machine?: string;
  model?: string;
  createdAt: Date;
  updatedAt: Date;
  /** `at` of the last report applied. */
  reportedAt: number;
}

const sessions = () => getDb().collection<SessionDoc>('sessions');

function toSession({
  _id,
  createdAt: _c,
  reportedAt: _r,
  updatedAt,
  ...rest
}: SessionDoc): Session {
  return { id: _id, ...rest, updatedAt: updatedAt.toISOString() };
}

// Live fan-out within this process. A second server instance would miss these events, so the
// deployment runs one replica until this moves to Mongo change streams.
const updates = new EventEmitter().setMaxListeners(0);

export function onSessionUpdate(listener: (session: Session) => void): () => void {
  updates.on('session', listener);
  return () => updates.off('session', listener);
}

export async function listSessions(): Promise<Session[]> {
  // First-seen order, so the dashboard never reorders sessions as they update.
  const docs = await sessions().find().sort({ createdAt: 1 }).toArray();
  return docs.map(toSession);
}

/** Applies a report, or returns undefined if a newer one already landed. */
export async function applyReport({
  sessionId,
  at,
  title,
  ...fields
}: SessionReport): Promise<Session | undefined> {
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
      { _id: sessionId, reportedAt: { $lt: at } },
      [
        {
          $set: {
            ...set,
            reportedAt: at,
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
  updates.emit('session', session);
  return session;
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}

import { EventEmitter } from 'node:events';
import { getDb } from '@joc/db';
import type { ChangesReport } from '@joc/protocol';

interface ChangesDoc {
  _id: string;
  base: string;
  diff: string;
  truncated: boolean;
  reportedAt: number;
  updatedAt: Date;
}

export interface SessionChanges {
  base: string;
  diff: string;
  truncated: boolean;
  updatedAt: string;
}

const changes = () => getDb().collection<ChangesDoc>('changes');

// Same in-process fan-out as session updates (see sessions.ts). Only the session id goes out:
// a diff can be megabytes, so each dashboard fetches it when it's showing that session.
const updates = new EventEmitter().setMaxListeners(0);

export function onChanges(listener: (sessionId: string) => void): () => void {
  updates.on('changes', listener);
  return () => updates.off('changes', listener);
}

/** Keeps the session's latest diff; an older report than the one stored is dropped. */
export async function saveChanges({ sessionId, at, ...diff }: ChangesReport): Promise<boolean> {
  try {
    await changes().updateOne(
      { _id: sessionId, reportedAt: { $lt: at } },
      { $set: { ...diff, reportedAt: at, updatedAt: new Date() } },
      { upsert: true },
    );
  } catch (error) {
    // A stale report: the filter missed a newer stored diff and the upsert hit its _id.
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
      return false;
    }
    throw error;
  }
  updates.emit('changes', sessionId);
  return true;
}

export async function getChanges(sessionId: string): Promise<SessionChanges | undefined> {
  const doc = await changes().findOne({ _id: sessionId });
  if (!doc) return undefined;
  return {
    base: doc.base,
    diff: doc.diff,
    truncated: doc.truncated,
    updatedAt: doc.updatedAt.toISOString(),
  };
}

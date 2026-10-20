import { getDb } from '@joc/db';
import type { ChangesReport } from '@joc/protocol';
import { publish } from './bus.ts';
import { type Owner, sessionKey } from './owner.ts';

interface ChangesDoc {
  /** `owner/sessionId` (see owner.ts). */
  _id: string;
  owner: string;
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

/** Keeps the session's latest diff; an older report than the one stored is dropped. */
export async function saveChanges(
  owner: Owner,
  { sessionId, at, ...diff }: ChangesReport,
): Promise<boolean> {
  try {
    await changes().updateOne(
      { _id: sessionKey(owner, sessionId), reportedAt: { $lt: at } },
      { $set: { ...diff, owner, reportedAt: at, updatedAt: new Date() } },
      { upsert: true },
    );
  } catch (error) {
    // A stale report: the filter missed a newer stored diff and the upsert hit its _id.
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
      return false;
    }
    throw error;
  }
  // Only the session id goes out: a diff can be megabytes, so each dashboard fetches it when
  // it's showing that session.
  publish(owner, { type: 'changes', sessionId });
  return true;
}

export async function getChanges(
  owner: Owner,
  sessionId: string,
): Promise<SessionChanges | undefined> {
  const doc = await changes().findOne({ _id: sessionKey(owner, sessionId), owner });
  if (!doc) return undefined;
  return {
    base: doc.base,
    diff: doc.diff,
    truncated: doc.truncated,
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/** Deletes a deleted session's diff. */
export async function forgetChanges(owner: Owner, sessionId: string): Promise<void> {
  await changes().deleteOne({ _id: sessionKey(owner, sessionId), owner });
}

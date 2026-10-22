import { getDb } from '@joc/db';
import type { McpServerStatus, SessionStatus, SessionStatusReport } from '@joc/protocol';
import { publish } from './bus.ts';
import { type Owner, sessionKey } from './owner.ts';

interface StatusDoc {
  /** `owner/sessionId` (see owner.ts). */
  _id: string;
  owner: string;
  version?: string;
  model?: string;
  cwd?: string;
  mcp: McpServerStatus[];
  reportedAt: number;
  updatedAt: Date;
}

const collection = () => getDb().collection<StatusDoc>('session_status');

/** Keeps the session's latest status; an older report than the one stored is dropped. */
export async function saveStatus(
  owner: Owner,
  { sessionId, at, version, model, cwd, mcp }: SessionStatusReport,
): Promise<boolean> {
  const fields = {
    owner,
    mcp,
    reportedAt: at,
    updatedAt: new Date(),
    ...(version ? { version } : {}),
    ...(model ? { model } : {}),
    ...(cwd ? { cwd } : {}),
  };
  try {
    await collection().replaceOne(
      { _id: sessionKey(owner, sessionId), reportedAt: { $lt: at } },
      fields,
      { upsert: true },
    );
  } catch (error) {
    // A stale report: the filter missed a newer stored status and the upsert hit its _id.
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
      return false;
    }
    throw error;
  }
  publish(owner, { type: 'session-status', sessionId });
  return true;
}

export async function getStatus(
  owner: Owner,
  sessionId: string,
): Promise<SessionStatus | undefined> {
  const doc = await collection().findOne({ _id: sessionKey(owner, sessionId), owner });
  if (!doc) return undefined;
  return {
    ...(doc.version ? { version: doc.version } : {}),
    ...(doc.model ? { model: doc.model } : {}),
    ...(doc.cwd ? { cwd: doc.cwd } : {}),
    mcp: doc.mcp,
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/** Deletes a deleted session's status. */
export async function forgetStatus(owner: Owner, sessionId: string): Promise<void> {
  await collection().deleteOne({ _id: sessionKey(owner, sessionId), owner });
}

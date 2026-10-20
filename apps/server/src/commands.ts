import { EventEmitter } from 'node:events';
import { getDb } from '@joc/db';
import type { CommandsReport, SessionCommands, SlashCommand } from '@joc/protocol';
import { type Owner, sessionKey } from './owner.ts';

interface CommandsDoc {
  /** `owner/sessionId` (see owner.ts). */
  _id: string;
  owner: string;
  commands: SlashCommand[];
  reportedAt: number;
  updatedAt: Date;
}

const collection = () => getDb().collection<CommandsDoc>('commands');

// Same in-process fan-out as diffs (see changes.ts): only the session id goes out, and each
// dashboard showing that session fetches the list.
const updates = new EventEmitter().setMaxListeners(0);

export function onCommands(owner: Owner, listener: (sessionId: string) => void): () => void {
  updates.on(`commands:${owner}`, listener);
  return () => updates.off(`commands:${owner}`, listener);
}

/** Keeps the session's latest command list; an older report than the one stored is dropped. */
export async function saveCommands(
  owner: Owner,
  { sessionId, at, commands }: CommandsReport,
): Promise<boolean> {
  try {
    await collection().updateOne(
      { _id: sessionKey(owner, sessionId), reportedAt: { $lt: at } },
      { $set: { owner, commands, reportedAt: at, updatedAt: new Date() } },
      { upsert: true },
    );
  } catch (error) {
    // A stale report: the filter missed a newer stored list and the upsert hit its _id.
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
      return false;
    }
    throw error;
  }
  updates.emit(`commands:${owner}`, sessionId);
  return true;
}

export async function getCommands(
  owner: Owner,
  sessionId: string,
): Promise<SessionCommands | undefined> {
  const doc = await collection().findOne({ _id: sessionKey(owner, sessionId), owner });
  if (!doc) return undefined;
  return { commands: doc.commands, updatedAt: doc.updatedAt.toISOString() };
}

/** Deletes a deleted session's command list. */
export async function forgetCommands(owner: Owner, sessionId: string): Promise<void> {
  await collection().deleteOne({ _id: sessionKey(owner, sessionId), owner });
}

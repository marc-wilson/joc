import { randomUUID } from 'node:crypto';
import { getDb } from '@joc/db';
import type { Owner } from './owner.ts';

interface PromptDoc {
  _id: string;
  owner: string;
  sessionId: string;
  text: string;
  createdAt: Date;
  claimedAt?: Date;
}

const prompts = () => getDb().collection<PromptDoc>('prompts');

/** Queues a prompt from the dashboard for the session's plugin to pick up. */
export async function queuePrompt(owner: Owner, sessionId: string, text: string): Promise<string> {
  const _id = randomUUID();
  await prompts().insertOne({ _id, owner, sessionId, text, createdAt: new Date() });
  return _id;
}

/**
 * Hands the session's queued prompts to its plugin, oldest first. Each is claimed atomically,
 * so two polls (or two plugins) never deliver the same prompt twice.
 */
export async function claimPrompts(
  owner: Owner,
  sessionId: string,
  max = 10,
): Promise<{ id: string; text: string }[]> {
  const claimed: { id: string; text: string }[] = [];
  while (claimed.length < max) {
    const doc = await prompts().findOneAndUpdate(
      { owner, sessionId, claimedAt: { $exists: false } },
      { $set: { claimedAt: new Date() } },
      { sort: { createdAt: 1 } },
    );
    if (!doc) break;
    claimed.push({ id: doc._id, text: doc.text });
  }
  return claimed;
}

import { randomUUID } from 'node:crypto';
import { getDb } from '@joc/db';
import type { ClaimedPrompt, ImageRef } from '@joc/protocol';
import type { Owner } from './owner.ts';

interface PromptDoc {
  _id: string;
  owner: string;
  sessionId: string;
  text: string;
  /** The owner's images sent with it; absent on prompts queued before images. */
  images?: ImageRef[];
  createdAt: Date;
  claimedAt?: Date;
}

const prompts = () => getDb().collection<PromptDoc>('prompts');

/** Queues a prompt from the dashboard for the session's plugin to pick up. */
export async function queuePrompt(
  owner: Owner,
  sessionId: string,
  text: string,
  images: ImageRef[] = [],
): Promise<string> {
  const _id = randomUUID();
  await prompts().insertOne({ _id, owner, sessionId, text, images, createdAt: new Date() });
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
): Promise<ClaimedPrompt[]> {
  const claimed: ClaimedPrompt[] = [];
  while (claimed.length < max) {
    const doc = await prompts().findOneAndUpdate(
      { owner, sessionId, claimedAt: { $exists: false } },
      { $set: { claimedAt: new Date() } },
      { sort: { createdAt: 1 } },
    );
    if (!doc) break;
    claimed.push({ id: doc._id, text: doc.text, images: doc.images ?? [] });
  }
  return claimed;
}

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

const imageIds = (docs: Pick<PromptDoc, 'images'>[]) =>
  docs.flatMap((p) => (p.images ?? []).map((i) => i.id));

/** Deletes a deleted session's prompts; the ids of the images they carried. */
export async function forgetPrompts(owner: Owner, sessionId: string): Promise<string[]> {
  const sent = await prompts()
    .find({ owner, sessionId }, { projection: { images: 1 } })
    .toArray();
  await prompts().deleteMany({ owner, sessionId });
  return imageIds(sent);
}

/** Which of `ids` a prompt of the owner's still carries. */
export async function imagesSent(owner: Owner, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const found = await prompts()
    .find({ owner, 'images.id': { $in: ids } }, { projection: { images: 1 } })
    .toArray();
  return new Set(imageIds(found).filter((id) => ids.includes(id)));
}

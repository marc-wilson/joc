import { randomUUID } from 'node:crypto';
import { getDb } from '@joc/db';
import type { ClaimedPrompt, ImageRef, PromptHandoff, PromptStatus } from '@joc/protocol';
import { publish } from './bus.ts';
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
  /** Whether the plugin that claimed it says when Claude Code took it (0.12.1 on). */
  reports?: boolean;
  /** When the plugin said Claude Code took it, or didn't (`failed`). */
  handedAt?: Date;
  failed?: string;
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
  publish(owner, { type: 'prompts', sessionId });
  return _id;
}

/**
 * Hands the session's queued prompts to its plugin, oldest first. Each is claimed atomically,
 * so two polls (or two plugins) never deliver the same prompt twice.
 */
export async function claimPrompts(
  owner: Owner,
  sessionId: string,
  { max = 10, reports = false }: { max?: number; reports?: boolean } = {},
): Promise<ClaimedPrompt[]> {
  const claimed: ClaimedPrompt[] = [];
  while (claimed.length < max) {
    const doc = await prompts().findOneAndUpdate(
      { owner, sessionId, claimedAt: { $exists: false } },
      { $set: { claimedAt: new Date(), reports } },
      { sort: { createdAt: 1 } },
    );
    if (!doc) break;
    claimed.push({ id: doc._id, text: doc.text, images: doc.images ?? [] });
  }
  if (claimed.length) publish(owner, { type: 'prompts', sessionId });
  return claimed;
}

/** Records whether Claude Code took a prompt the plugin claimed. False when there's no such one. */
export async function handOffPrompt(
  owner: Owner,
  sessionId: string,
  id: string,
  { ok, reason }: PromptHandoff,
): Promise<boolean> {
  const done = await prompts().updateOne(
    { _id: id, owner, sessionId, claimedAt: { $exists: true } },
    {
      $set: {
        handedAt: new Date(),
        ...(ok ? {} : { failed: reason || "claude code didn't take it" }),
      },
    },
  );
  if (done.matchedCount) publish(owner, { type: 'prompts', sessionId });
  return done.matchedCount > 0;
}

/**
 * Withdraws a prompt still in JOC. `taken` once the plugin has claimed it: Claude Code has it
 * (or is about to), and nothing in JOC can take it back.
 */
export async function cancelPrompt(
  owner: Owner,
  sessionId: string,
  id: string,
): Promise<'cancelled' | 'taken' | 'missing'> {
  const gone = await prompts().findOneAndDelete({
    _id: id,
    owner,
    sessionId,
    claimedAt: { $exists: false },
  });
  if (gone) {
    publish(owner, { type: 'prompts', sessionId });
    return 'cancelled';
  }
  return (await prompts().countDocuments({ _id: id, owner, sessionId })) ? 'taken' : 'missing';
}

/** How long the dashboard is told where a sent prompt stands. */
const STATUS_FOR_MS = 24 * 60 * 60_000;

const phaseOf = (doc: PromptDoc): PromptStatus['phase'] => {
  if (doc.failed) return 'failed';
  if (!doc.claimedAt) return 'waiting';
  return doc.handedAt || !doc.reports ? 'queued' : 'claimed';
};

/** Where the session's recent prompts stand, oldest first. */
export async function listPrompts(owner: Owner, sessionId: string): Promise<PromptStatus[]> {
  const docs = await prompts()
    .find(
      { owner, sessionId, createdAt: { $gt: new Date(Date.now() - STATUS_FOR_MS) } },
      { projection: { text: 0, images: 0 } },
    )
    .sort({ createdAt: -1 })
    .limit(100)
    .toArray();
  return docs.reverse().map((d) => ({
    id: d._id,
    phase: phaseOf(d),
    ...(d.failed ? { reason: d.failed } : {}),
  }));
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

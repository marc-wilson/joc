import { EventEmitter } from 'node:events';
import { getDb } from '@joc/db';
import type { ConversationItem, MessagesReport } from '@joc/protocol';
import { type Owner, sessionKey } from './owner.ts';

/** `_id` is `owner/sessionId:itemId`; `owner` is filtered on every read. */
type MessageDoc = ConversationItem & { _id: string; owner: string; sessionId: string };

const messages = () => getDb().collection<MessageDoc>('messages');

let indexed: Promise<string> | undefined;
const ensureIndex = () => {
  indexed ??= messages().createIndex({ owner: 1, sessionId: 1, at: 1, id: 1 });
  return indexed;
};

// Same per-owner, in-process fan-out as session updates (see sessions.ts).
const updates = new EventEmitter().setMaxListeners(0);

export function onMessages(
  owner: Owner,
  listener: (sessionId: string, items: ConversationItem[]) => void,
): () => void {
  updates.on(`messages:${owner}`, listener);
  return () => updates.off(`messages:${owner}`, listener);
}

function toItem({ _id: _, owner: _o, sessionId: _s, ...item }: MessageDoc): ConversationItem {
  return item as ConversationItem;
}

/**
 * The latest `limit` items of a session's conversation, oldest first. With `task`, the steps of
 * that background subagent instead; without, the session's own conversation (no subagent steps).
 */
export async function listMessages(
  owner: Owner,
  sessionId: string,
  { task, limit = 1000 }: { task?: string; limit?: number } = {},
): Promise<ConversationItem[]> {
  await ensureIndex();
  const docs = await messages()
    .find({ owner, sessionId, task: task ?? { $exists: false } })
    .sort({ at: -1, id: -1 })
    .limit(limit)
    .toArray();
  return docs.reverse().map(toItem);
}

/** Saves items it hasn't seen (hooks can send the same lines twice) and publishes only those. */
export async function addMessages(
  owner: Owner,
  { sessionId, items }: MessagesReport,
): Promise<number> {
  if (!items.length) return 0;
  await ensureIndex();
  const result = await messages().bulkWrite(
    items.map((item) => ({
      updateOne: {
        filter: { _id: `${sessionKey(owner, sessionId)}:${item.id}` },
        update: { $setOnInsert: { ...item, owner, sessionId } },
        upsert: true,
      },
    })),
    { ordered: false },
  );
  const fresh = Object.keys(result.upsertedIds).map((i) => items[Number(i)] as ConversationItem);
  if (fresh.length) updates.emit(`messages:${owner}`, sessionId, fresh);
  return fresh.length;
}

/** How many messages each of the owner's sessions has. */
export async function countMessages(
  owner: Owner,
  sessionIds: string[],
): Promise<Map<string, number>> {
  await ensureIndex();
  const rows = await messages()
    .aggregate<{ _id: string; n: number }>([
      // Tool results and command output ride along with their calls, so they don't count; nor
      // do a subagent's own steps.
      {
        $match: {
          owner,
          sessionId: { $in: sessionIds },
          task: { $exists: false },
          kind: { $nin: ['tool_result', 'command_output'] },
        },
      },
      { $group: { _id: '$sessionId', n: { $sum: 1 } } },
    ])
    .toArray();
  return new Map(rows.map((r) => [r._id, r.n]));
}

const imageIds = (docs: { images?: { id: string }[] }[]) =>
  docs.flatMap((d) => (d.images ?? []).map((i) => i.id));

/** Deletes a deleted session's conversation; the ids of the images it showed. */
export async function forgetMessages(owner: Owner, sessionId: string): Promise<string[]> {
  const shown = await messages()
    .find({ owner, sessionId, 'images.0': { $exists: true } }, { projection: { images: 1 } })
    .toArray();
  await messages().deleteMany({ owner, sessionId });
  return imageIds(shown as { images?: { id: string }[] }[]);
}

/** Which of `ids` an item in any of the owner's conversations still shows. */
export async function imagesShown(owner: Owner, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const found = await messages()
    .find({ owner, 'images.id': { $in: ids } }, { projection: { images: 1 } })
    .toArray();
  return new Set(
    imageIds(found as { images?: { id: string }[] }[]).filter((id) => ids.includes(id)),
  );
}

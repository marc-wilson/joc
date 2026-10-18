import { EventEmitter } from 'node:events';
import { getDb } from '@joc/db';
import type { ConversationItem, MessagesReport } from '@joc/protocol';

type MessageDoc = ConversationItem & { _id: string; sessionId: string };

const messages = () => getDb().collection<MessageDoc>('messages');

let indexed: Promise<string> | undefined;
const ensureIndex = () => {
  indexed ??= messages().createIndex({ sessionId: 1, at: 1, id: 1 });
  return indexed;
};

// Same in-process fan-out as session updates (see sessions.ts).
const updates = new EventEmitter().setMaxListeners(0);

export function onMessages(
  listener: (sessionId: string, items: ConversationItem[]) => void,
): () => void {
  updates.on('messages', listener);
  return () => updates.off('messages', listener);
}

function toItem({ _id: _, sessionId: _s, ...item }: MessageDoc): ConversationItem {
  return item as ConversationItem;
}

/** The latest `limit` items of a session's conversation, oldest first. */
export async function listMessages(sessionId: string, limit = 1000): Promise<ConversationItem[]> {
  await ensureIndex();
  const docs = await messages().find({ sessionId }).sort({ at: -1, id: -1 }).limit(limit).toArray();
  return docs.reverse().map(toItem);
}

/** Saves items it hasn't seen (hooks can send the same lines twice) and publishes only those. */
export async function addMessages({ sessionId, items }: MessagesReport): Promise<number> {
  if (!items.length) return 0;
  await ensureIndex();
  const result = await messages().bulkWrite(
    items.map((item) => ({
      updateOne: {
        filter: { _id: `${sessionId}:${item.id}` },
        update: { $setOnInsert: { ...item, sessionId } },
        upsert: true,
      },
    })),
    { ordered: false },
  );
  const fresh = Object.keys(result.upsertedIds).map((i) => items[Number(i)] as ConversationItem);
  if (fresh.length) updates.emit('messages', sessionId, fresh);
  return fresh.length;
}

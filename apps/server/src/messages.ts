import { getDb } from '@joc/db';
import type { ConversationItem, MessagesReport } from '@joc/protocol';
import { publish } from './bus.ts';
import { type Owner, sessionKey } from './owner.ts';

/** `_id` is `owner/sessionId:itemId`; `owner` is filtered on every read. */
type MessageDoc = ConversationItem & { _id: string; owner: string; sessionId: string };

const messages = () => getDb().collection<MessageDoc>('messages');

let indexed: Promise<string> | undefined;
const ensureIndex = () => {
  indexed ??= messages().createIndex({ owner: 1, sessionId: 1, at: 1, id: 1 });
  return indexed;
};

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

/**
 * Saves items it hasn't seen (hooks can send the same lines twice), publishes only those and
 * returns them.
 */
export async function addMessages(
  owner: Owner,
  { sessionId, items }: MessagesReport,
): Promise<ConversationItem[]> {
  if (!items.length) return [];
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
  if (fresh.length) publish(owner, { type: 'messages', sessionId, items: fresh });
  return fresh;
}

/** Whether an item of the session's own conversation can change where its teammates stand. */
export function movesTeam(item: ConversationItem): boolean {
  if (item.task) return false;
  if (item.kind === 'tool_call') return !!item.subagent || !!item.to;
  return (
    item.kind === 'tool_result' || item.kind === 'task_update' || item.kind === 'agent_message'
  );
}

/** The most items a team is worked out from: the latest. */
const TEAM_ITEMS = 5000;

/**
 * The items of the session's own conversation that say where its teammates stand (see
 * `teamDrafts`), oldest first: Agent and SendMessage calls, the Agent calls' results, stops,
 * task notifications and the teammates' messages.
 */
export async function teamItems(owner: Owner, sessionId: string): Promise<ConversationItem[]> {
  await ensureIndex();
  const main = { owner, sessionId, task: { $exists: false } };
  const calls = await messages()
    .find(
      { ...main, kind: 'tool_call', subagent: { $exists: true } },
      { projection: { toolUseId: 1 } },
    )
    .sort({ at: -1, id: -1 })
    .limit(TEAM_ITEMS)
    .toArray();
  const agents = calls.flatMap((c) => ('toolUseId' in c ? [c.toolUseId] : []));
  const docs = await messages()
    .find({
      ...main,
      $or: [
        { kind: 'tool_call', subagent: { $exists: true } },
        { kind: 'tool_call', to: { $exists: true } },
        { kind: { $in: ['task_update', 'agent_message'] } },
        { kind: 'tool_result', toolUseId: { $in: agents } },
        { kind: 'tool_result', text: { $regex: '^Successfully stopped task: ' } },
      ],
    })
    .sort({ at: -1, id: -1 })
    .limit(TEAM_ITEMS)
    .toArray();
  return docs.reverse().map(toItem);
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

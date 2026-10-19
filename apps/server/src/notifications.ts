// The person's unread GitHub notifications, as their plugin last read them, and the threads they
// asked to mark read. One snapshot document per owner, the newest from any of their machines.
// Marking read is queued: any of the owner's machines takes the queue on its next read and tells
// GitHub through `gh`. Until GitHub agrees, the snapshot hides those threads.
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { getDb } from '@joc/db';
import type { NotificationsReport, NotificationsSnapshot } from '@joc/protocol';
import type { Owner } from './owner.ts';

type SnapshotDoc = Omit<NotificationsReport, 'at'> & {
  _id: string;
  reportedAt: number;
  updatedAt: Date;
};

interface ReadDoc {
  _id: string;
  owner: string;
  threadId: string;
  requestedAt: Date;
  claimedAt?: Date;
}

/** How long a mark-read request hides its thread: GitHub has long caught up by then. */
const READ_KEPT_MS = 7 * 24 * 60 * 60_000;

const snapshots = () => getDb().collection<SnapshotDoc>('notifications');
const reads = () => getDb().collection<ReadDoc>('notification_reads');

let indexed: Promise<unknown> | undefined;
/** Mongo drops old mark-read requests on its own (TTL). */
const ensureIndexes = () => {
  indexed ??= Promise.all([
    reads().createIndex({ requestedAt: 1 }, { expireAfterSeconds: READ_KEPT_MS / 1000 }),
    reads().createIndex({ owner: 1, claimedAt: 1, requestedAt: 1 }),
  ]);
  return indexed;
};

// Same per-owner, in-process fan-out as session updates (see sessions.ts). Only a nudge goes
// out; each dashboard fetches the snapshot.
const updates = new EventEmitter().setMaxListeners(0);
const changed = (owner: Owner) => updates.emit(`notifications:${owner}`);

export function onNotifications(owner: Owner, listener: () => void): () => void {
  updates.on(`notifications:${owner}`, listener);
  return () => updates.off(`notifications:${owner}`, listener);
}

/** Keeps the owner's newest report; an older one than stored is dropped. */
export async function saveNotifications(
  owner: Owner,
  { at, ...report }: NotificationsReport,
): Promise<boolean> {
  try {
    await snapshots().updateOne(
      { _id: owner, reportedAt: { $lt: at } },
      { $set: { ...report, reportedAt: at, updatedAt: new Date() } },
      { upsert: true },
    );
  } catch (error) {
    // A stale report: the filter missed a newer stored one and the upsert hit its _id.
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
      return false;
    }
    throw error;
  }
  changed(owner);
  return true;
}

/** When each thread was last asked to be marked read. */
async function readRequests(owner: Owner): Promise<Map<string, Date>> {
  await ensureIndexes();
  const docs = await reads().find({ owner }).toArray();
  const latest = new Map<string, Date>();
  for (const doc of docs) {
    const known = latest.get(doc.threadId);
    if (!known || known < doc.requestedAt) latest.set(doc.threadId, doc.requestedAt);
  }
  return latest;
}

export async function getNotifications(owner: Owner): Promise<NotificationsSnapshot> {
  const doc = await snapshots().findOne({ _id: owner });
  if (!doc) return { state: 'none' };
  const requested = await readRequests(owner);
  return {
    state: 'reported',
    status: doc.status,
    // A thread marked read stays hidden unless something new happened on it since.
    threads: doc.threads.filter((t) => {
      const at = requested.get(t.id);
      return !at || Date.parse(t.updatedAt) > at.getTime();
    }),
    more: doc.more,
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/** Queues the threads to be marked read on GitHub by the owner's next machine to read. */
export async function markRead(owner: Owner, threadIds: string[]): Promise<void> {
  await ensureIndexes();
  const requestedAt = new Date();
  const unique = [...new Set(threadIds)];
  await reads().insertMany(
    unique.map((threadId) => ({ _id: randomUUID(), owner, threadId, requestedAt })),
  );
  changed(owner);
}

/** Marks every thread the owner can see read; returns how many. */
export async function markAllRead(owner: Owner): Promise<number> {
  const snapshot = await getNotifications(owner);
  const ids = snapshot.state === 'reported' ? snapshot.threads.map((t) => t.id) : [];
  if (ids.length) await markRead(owner, ids);
  return ids.length;
}

/**
 * Hands the queued mark-read requests to one of the owner's machines. Each is claimed
 * atomically, so two machines never both take one.
 */
export async function claimReads(owner: Owner, max = 200): Promise<string[]> {
  await ensureIndexes();
  const claimed = new Set<string>();
  while (claimed.size < max) {
    const doc = await reads().findOneAndUpdate(
      { owner, claimedAt: { $exists: false } },
      { $set: { claimedAt: new Date() } },
      { sort: { requestedAt: 1 } },
    );
    if (!doc) break;
    claimed.add(doc.threadId);
  }
  return [...claimed];
}

// The person's unread GitHub notifications, as their plugin last read them, and the threads they
// asked to mark read. One snapshot document per owner, the newest from any of their machines.
// Marking read is queued: any of the owner's machines takes the queue on its next read and tells
// GitHub through `gh`. Until GitHub agrees, the snapshot hides those threads.
import { randomUUID } from 'node:crypto';
import { getDb } from '@joc/db';
import type { NotificationsReport, NotificationsSnapshot } from '@joc/protocol';
import { publish } from './bus.ts';
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
  /** The thread's GitHub `updatedAt` when it was marked read, if the snapshot had it. */
  seen?: string;
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

// Only a nudge goes out to the owner's dashboards; each fetches the snapshot.
const changed = (owner: Owner) => publish(owner, { type: 'notifications' });

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

/**
 * Up to when each thread was read: the newest of when it was asked to be and the version of it
 * the person saw then. GitHub's clock and ours needn't agree, so the version counts too.
 */
async function readRequests(owner: Owner): Promise<Map<string, number>> {
  await ensureIndexes();
  const docs = await reads().find({ owner }).toArray();
  const latest = new Map<string, number>();
  for (const doc of docs) {
    const at = Math.max(doc.requestedAt.getTime(), doc.seen ? Date.parse(doc.seen) || 0 : 0);
    latest.set(doc.threadId, Math.max(latest.get(doc.threadId) ?? 0, at));
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
      return at === undefined || Date.parse(t.updatedAt) > at;
    }),
    more: doc.more,
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/**
 * Queues the threads to be marked read on GitHub by the owner's next machine to read, and
 * returns the snapshot after. A thread still queued is queued once however often it's asked
 * for, and the dashboards hear only when a thread they show leaves.
 */
export async function markRead(owner: Owner, threadIds: string[]): Promise<NotificationsSnapshot> {
  await ensureIndexes();
  const requestedAt = new Date();
  const before = await getNotifications(owner);
  // The version of each thread the person saw, and so marked read.
  const seen = new Map(
    before.state === 'reported' ? before.threads.map((t) => [t.id, t.updatedAt]) : [],
  );
  const unique = [...new Set(threadIds)];
  // One round trip for them all: clearing ninety at once is as quick as one.
  await reads().bulkWrite(
    unique.map((threadId) => {
      const version = seen.get(threadId);
      return {
        updateOne: {
          filter: { owner, threadId, claimedAt: { $exists: false } },
          update: {
            $set: { requestedAt, ...(version ? { seen: version } : {}) },
            $setOnInsert: { _id: randomUUID() },
          },
          upsert: true,
        },
      };
    }),
    { ordered: false },
  );
  if (unique.some((id) => seen.has(id))) changed(owner);
  return getNotifications(owner);
}

/** Marks every thread the owner can see read; returns the snapshot after. */
export async function markAllRead(owner: Owner): Promise<NotificationsSnapshot> {
  const snapshot = await getNotifications(owner);
  const ids = snapshot.state === 'reported' ? snapshot.threads.map((t) => t.id) : [];
  return ids.length ? markRead(owner, ids) : snapshot;
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

// The person's alerts: what involved them, kept so they can look back on what they missed. The
// server raises them from reports (sessions.ts, github-data.ts); the dashboard lists them, marks
// them read and clears them. One document per alert, always looked up with its owner.
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { getDb } from '@joc/db';
import { type Alert, type AlertKind, MAX_ALERTS, type PullRequest } from '@joc/protocol';
import type { Owner } from './owner.ts';

interface AlertDoc {
  _id: string;
  owner: string;
  kind: AlertKind;
  title: string;
  detail?: string;
  repo: string;
  sessionId?: string;
  number?: number;
  url?: string;
  createdAt: Date;
  readAt?: Date;
}

/** How long an alert is kept. */
const KEPT_MS = 30 * 24 * 60 * 60_000;

const alerts = () => getDb().collection<AlertDoc>('alerts');

let indexed: Promise<unknown> | undefined;
/** Mongo drops old alerts on its own (TTL). */
const ensureIndexes = () => {
  indexed ??= Promise.all([
    alerts().createIndex({ createdAt: 1 }, { expireAfterSeconds: KEPT_MS / 1000 }),
    alerts().createIndex({ owner: 1, createdAt: -1 }),
  ]);
  return indexed;
};

// Same per-owner, in-process fan-out as session updates (see sessions.ts). Only a nudge goes
// out; each dashboard fetches the list.
const updates = new EventEmitter().setMaxListeners(0);
const changed = (owner: Owner) => updates.emit(`alerts:${owner}`);

export function onAlerts(owner: Owner, listener: () => void): () => void {
  updates.on(`alerts:${owner}`, listener);
  return () => updates.off(`alerts:${owner}`, listener);
}

const toAlert = ({ _id, owner: _o, createdAt, readAt, ...rest }: AlertDoc): Alert => ({
  id: _id,
  ...rest,
  at: createdAt.toISOString(),
  read: readAt !== undefined,
});

type NewAlert = Omit<AlertDoc, '_id' | 'owner' | 'createdAt' | 'readAt'>;

async function add(owner: Owner, list: NewAlert[]): Promise<void> {
  if (!list.length) return;
  await ensureIndexes();
  const createdAt = new Date();
  await alerts().insertMany(
    list.map((a) => ({
      // Left out, not stored as null.
      ...(Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)) as NewAlert),
      _id: randomUUID(),
      owner,
      createdAt,
    })),
  );
  // Keep the newest MAX_ALERTS.
  const old = await alerts()
    .find({ owner }, { projection: { _id: 1 } })
    .sort({ createdAt: -1, _id: -1 })
    .skip(MAX_ALERTS)
    .toArray();
  if (old.length) await alerts().deleteMany({ owner, _id: { $in: old.map((d) => d._id) } });
  changed(owner);
}

interface SessionChange {
  sessionId: string;
  title?: string;
  repo: string;
  activity?: string;
  state: string;
}

/**
 * The alert a session's report raises, if any: it went to `needs`, or a turn ended (working to
 * idle or background). Leaving `needs` marks its `needs` alerts read: it's been answered.
 */
export async function alertOnSession(
  owner: Owner,
  was: string | undefined,
  now: SessionChange,
): Promise<void> {
  if (was === now.state) return;
  const about = {
    sessionId: now.sessionId,
    title: now.title ?? 'New session',
    repo: now.repo,
    detail: now.activity,
  };
  if (was === 'needs') await readSession(owner, now.sessionId);
  if (now.state === 'needs') await add(owner, [{ kind: 'needs', ...about }]);
  else if (was === 'working' && (now.state === 'idle' || now.state === 'background')) {
    await add(owner, [{ kind: 'finished', ...about }]);
  }
}

async function readSession(owner: Owner, sessionId: string) {
  const res = await alerts().updateMany(
    { owner, sessionId, kind: 'needs', readAt: { $exists: false } },
    { $set: { readAt: new Date() } },
  );
  if (res.modifiedCount) changed(owner);
}

const prKey = (p: PullRequest) => `${p.repo}#${p.number}`;

/** A review alert for each pull request that newly asks for the person's review. */
export async function alertOnReviews(
  owner: Owner,
  before: PullRequest[],
  now: PullRequest[],
): Promise<void> {
  const known = new Set(before.map(prKey));
  await add(
    owner,
    now
      .filter((p) => !known.has(prKey(p)))
      .map((p) => ({
        kind: 'review' as const,
        title: p.title,
        detail: p.author,
        repo: p.repo,
        number: p.number,
        url: p.url,
      })),
  );
}

/** The owner's alerts, newest first. */
export async function listAlerts(owner: Owner): Promise<Alert[]> {
  await ensureIndexes();
  const docs = await alerts()
    .find({ owner })
    .sort({ createdAt: -1, _id: -1 })
    .limit(MAX_ALERTS)
    .toArray();
  return docs.map(toAlert);
}

/** Marks the owner's alerts read: these, or all of them. */
export async function readAlerts(owner: Owner, ids?: string[]): Promise<void> {
  await alerts().updateMany(
    { owner, readAt: { $exists: false }, ...(ids ? { _id: { $in: ids } } : {}) },
    { $set: { readAt: new Date() } },
  );
  changed(owner);
}

/** Clears the owner's alerts: these, or all of them. */
export async function clearAlerts(owner: Owner, ids?: string[]): Promise<void> {
  await alerts().deleteMany({ owner, ...(ids ? { _id: { $in: ids } } : {}) });
  changed(owner);
}

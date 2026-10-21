// The person's alerts: what involved them, kept so they can look back on what they missed. The
// server raises them from reports (sessions.ts, github-data.ts); the dashboard lists them, marks
// them read and clears them. One document per alert, always looked up with its owner.
import { randomUUID } from 'node:crypto';
import { getDb } from '@joc/db';
import {
  type Alert,
  AlertKind,
  type GitHubReport,
  LONG_TURN_MS,
  MAX_ALERTS,
  type PullRequest,
} from '@joc/protocol';
import { publish } from './bus.ts';
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
  branch?: string;
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

// Only a nudge goes out to the owner's dashboards; each fetches the list.
const changed = (owner: Owner) => publish(owner, { type: 'alerts' });

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
  /** How long the turn ran, from its start to this report. */
  turnMs?: number;
}

/**
 * The alert a session's report raises, if any: it went to `needs`, or a turn that ran past
 * LONG_TURN_MS ended (working to idle or background). A short turn's end isn't news. Leaving
 * `needs` marks its `needs` alerts read: it's been answered.
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
  else if (
    was === 'working' &&
    (now.state === 'idle' || now.state === 'background') &&
    (now.turnMs ?? 0) > LONG_TURN_MS
  ) {
    await add(owner, [{ kind: 'long-turn', ...about }]);
  }
}

async function readSession(owner: Owner, sessionId: string) {
  const res = await alerts().updateMany(
    { owner, sessionId, kind: 'needs', readAt: { $exists: false } },
    { $set: { readAt: new Date() } },
  );
  if (res.modifiedCount) changed(owner);
}

const prKey = (p: Pick<PullRequest, 'repo' | 'number'>) => `${p.repo}#${p.number}`;

type Pulls = Pick<GitHubReport, 'status' | 'reviewRequested' | 'mine'>;

/**
 * What a GitHub read raises and resolves. Against a good earlier read: a review alert for each
 * pull request newly asking for the person's review, and a CI alert for each of theirs whose CI
 * newly failed. (The first read, or one after `gh` failed, is the starting point, not a burst.)
 * Then, on any good read, the alerts it resolves read themselves: a review request no longer
 * asked (reviewed, withdrawn, closed), CI no longer failing (or its pull request closed).
 */
export async function alertOnGitHub(owner: Owner, before: Pulls | null, now: Pulls) {
  if (now.status !== 'ok') return;
  if (before?.status === 'ok') {
    const asked = new Set(before.reviewRequested.map(prKey));
    const failing = new Set(before.mine.filter((p) => p.ci === 'fail').map(prKey));
    await add(owner, [
      ...now.reviewRequested
        .filter((p) => !asked.has(prKey(p)))
        .map((p) => ({
          kind: 'review' as const,
          title: p.title,
          detail: p.author,
          repo: p.repo,
          number: p.number,
          url: p.url,
        })),
      ...now.mine
        .filter((p) => p.ci === 'fail' && !failing.has(prKey(p)))
        .map((p) => ({
          kind: 'ci-failed' as const,
          title: p.title,
          detail: p.ciDetail,
          repo: p.repo,
          number: p.number,
          branch: p.branch,
          url: p.url,
        })),
    ]);
  }
  await resolvePulls(owner, now);
}

async function resolvePulls(owner: Owner, now: Pulls) {
  const asked = new Set(now.reviewRequested.map(prKey));
  const failing = new Set(now.mine.filter((p) => p.ci === 'fail').map(prKey));
  const open = await alerts()
    .find(
      { owner, kind: { $in: ['review', 'ci-failed'] }, readAt: { $exists: false } },
      { projection: { _id: 1, kind: 1, repo: 1, number: 1 } },
    )
    .toArray();
  const resolved = open.filter((a) => {
    const key = prKey({ repo: a.repo, number: a.number ?? 0 });
    return a.kind === 'review' ? !asked.has(key) : !failing.has(key);
  });
  if (!resolved.length) return;
  const res = await alerts().updateMany(
    { owner, _id: { $in: resolved.map((a) => a._id) }, readAt: { $exists: false } },
    { $set: { readAt: new Date() } },
  );
  if (res.modifiedCount) changed(owner);
}

/**
 * Alerts of a kind no longer raised (every turn's end, `finished`) go, once per owner per
 * process, so the count starts honest.
 */
const migrated = new Set<Owner>();
async function dropRetired(owner: Owner) {
  if (migrated.has(owner)) return;
  await alerts().deleteMany({ owner, kind: { $nin: [...AlertKind.options] } });
  migrated.add(owner);
}

/** The owner's alerts, newest first. */
export async function listAlerts(owner: Owner): Promise<Alert[]> {
  await ensureIndexes();
  await dropRetired(owner);
  const docs = await alerts()
    .find({ owner, kind: { $in: [...AlertKind.options] } })
    .sort({ createdAt: -1, _id: -1 })
    .limit(MAX_ALERTS)
    .toArray();
  return docs.map(toAlert);
}

/**
 * Marks the owner's alerts read: these, or all of them. Asking again changes nothing and tells
 * no one; the list after is what the dashboard shows.
 */
export async function readAlerts(owner: Owner, ids?: string[]): Promise<Alert[]> {
  const res = await alerts().updateMany(
    { owner, readAt: { $exists: false }, ...(ids ? { _id: { $in: ids } } : {}) },
    { $set: { readAt: new Date() } },
  );
  if (res.modifiedCount) changed(owner);
  return listAlerts(owner);
}

/** Clears the owner's alerts: these, or all of them. Like reading, safe to ask twice. */
export async function clearAlerts(owner: Owner, ids?: string[]): Promise<Alert[]> {
  const res = await alerts().deleteMany({ owner, ...(ids ? { _id: { $in: ids } } : {}) });
  if (res.deletedCount) changed(owner);
  return listAlerts(owner);
}

/** Deletes the alerts about a deleted session. */
export async function forgetAlerts(owner: Owner, sessionId: string): Promise<void> {
  const res = await alerts().deleteMany({ owner, sessionId });
  if (res.deletedCount) changed(owner);
}

// Operations' live activity (#114): a short log, per owner, of what JOC heard happen to their
// work. Appended where JOC already learns of things: a session's report changing its state
// (sessions.ts), and a change in the owner's GitHub lists (github-data.ts). Bounded: the last
// ACTIVITY_KEEP events, none older than ACTIVITY_KEEP_MS. New ones go out on the owner's live
// stream.
import { randomUUID } from 'node:crypto';
import { getDb } from '@joc/db';
import {
  ACTIVITY_KEEP,
  ACTIVITY_KEEP_MS,
  type ActivityEvent,
  type PullRequest,
  type Session,
  type SessionState,
} from '@joc/protocol';
import { publish } from './bus.ts';
import type { Owner } from './owner.ts';

interface ActivityDoc extends Omit<ActivityEvent, 'id' | 'at'> {
  _id: string;
  owner: string;
  at: Date;
}

/** An event to record; it's stamped with an id and the time it was heard. */
export type ActivityInput = Omit<ActivityEvent, 'id' | 'at'>;

const activity = () => getDb().collection<ActivityDoc>('activity');

let indexed: Promise<unknown> | undefined;
const ensureIndexes = () => {
  indexed ??= Promise.all([
    activity().createIndex({ owner: 1, at: -1 }),
    activity().createIndex({ at: 1 }, { expireAfterSeconds: ACTIVITY_KEEP_MS / 1000 }),
  ]);
  return indexed;
};

const toEvent = ({ _id, owner: _o, at, ...rest }: ActivityDoc): ActivityEvent => ({
  id: _id,
  at: at.toISOString(),
  ...rest,
});

/** Records the owner's events, keeps only their latest ACTIVITY_KEEP, and tells their streams. */
export async function recordActivity(
  owner: Owner,
  inputs: ActivityInput[],
  now = Date.now(),
): Promise<void> {
  if (!inputs.length) return;
  await ensureIndexes();
  // One millisecond apart, in the order given, so the newest-first order is theirs.
  const docs: ActivityDoc[] = inputs.map((input, i) => ({
    ...input,
    _id: randomUUID(),
    owner,
    at: new Date(now + i - inputs.length + 1),
  }));
  await activity().insertMany(docs);
  const over = await activity()
    .find({ owner }, { projection: { _id: 1 } })
    .sort({ at: -1, _id: -1 })
    .skip(ACTIVITY_KEEP)
    .toArray();
  if (over.length) await activity().deleteMany({ owner, _id: { $in: over.map((d) => d._id) } });
  publish(owner, { type: 'activity', events: docs.map(toEvent).reverse() });
}

/** The owner's latest events, newest first. */
export async function listActivity(owner: Owner, limit = 50): Promise<ActivityEvent[]> {
  const docs = await activity()
    .find({ owner })
    .sort({ at: -1, _id: -1 })
    .limit(Math.min(limit, ACTIVITY_KEEP))
    .toArray();
  return docs.map(toEvent);
}

// ── Sessions ───────────────────────────────────────────────────────────────

/**
 * What a session's state change says happened: it went to work, asked you, finished, or left
 * work running in the background. Undefined when the state didn't change, or ended the session.
 */
export function sessionActivity(
  previous: SessionState | undefined,
  session: Pick<Session, 'id' | 'state' | 'repo' | 'title'>,
): ActivityInput | undefined {
  const { state } = session;
  if (state === previous) return undefined;
  const kind =
    state === 'working'
      ? previous === 'needs'
        ? undefined
        : 'started'
      : state === 'needs'
        ? 'asked'
        : state === 'background'
          ? previous === 'working' || previous === 'needs'
            ? 'background'
            : undefined
          : state === 'idle'
            ? previous === 'working' || previous === 'needs' || previous === 'background'
              ? 'finished'
              : undefined
            : undefined;
  if (!kind) return undefined;
  return {
    kind,
    repo: session.repo,
    title: session.title ?? 'New session',
    sessionId: session.id,
  };
}

// ── GitHub ─────────────────────────────────────────────────────────────────

/** The owner's GitHub lists, before or after a change. */
export interface ActivityLists {
  reviewRequested: PullRequest[];
  mine: PullRequest[];
  /** The App's only: their pull requests that closed lately. */
  recent?: PullRequest[];
  /** When this copy was saved. */
  updatedAt?: Date;
}

/** Something older than the copy before, by this much, was there already: not news. */
const NEWS_SLACK_MS = 5 * 60_000;

const keyOf = (p: PullRequest) => `${p.repo.toLowerCase()}#${p.number}`;

const checks = (n: number) => `${n} ${n === 1 ? 'check' : 'checks'}`;

/** What a CI result says: the failing checks' names, or how many passed. */
function ciDetail(pr: PullRequest): string | undefined {
  const all = pr.checks ?? [];
  if (pr.ci === 'fail') {
    const failing = all.filter((c) => c.status === 'fail').map((c) => c.name);
    return failing.length ? failing.join(', ').slice(0, 300) : undefined;
  }
  return all.length ? checks(all.length) : undefined;
}

const REVIEW_KIND = {
  approved: 'approved',
  'changes-requested': 'changes',
  commented: 'commented',
} as const;

/**
 * What changed between two copies of the owner's GitHub lists: pull requests of theirs that
 * opened, merged or deployed, CI that passed or failed, and reviews that came in. Nothing for the
 * first copy, which only says how things stand.
 */
export function githubActivity(
  before: ActivityLists | null | undefined,
  after: ActivityLists,
): ActivityInput[] {
  if (!before) return [];
  const since = (before.updatedAt?.getTime() ?? 0) - NEWS_SLACK_MS;
  const fresh = (iso: string | undefined) => !iso || Date.parse(iso) >= since;
  const was = new Map<string, PullRequest>();
  for (const p of [...(before.recent ?? []), ...before.reviewRequested, ...before.mine]) {
    was.set(keyOf(p), p);
  }
  const out: ActivityInput[] = [];
  const about = (p: PullRequest) => ({ repo: p.repo, title: p.title, number: p.number });
  const mine = new Set(after.mine.map(keyOf));
  const open = new Map<string, PullRequest>();
  for (const p of [...after.reviewRequested, ...after.mine]) open.set(keyOf(p), p);

  for (const p of open.values()) {
    const old = was.get(keyOf(p));
    if (!old) {
      if (mine.has(keyOf(p)) && fresh(p.createdAt)) {
        out.push({ kind: 'opened', ...about(p) });
      }
      continue;
    }
    if (old.ci !== p.ci && (p.ci === 'pass' || p.ci === 'fail')) {
      const detail = ciDetail(p);
      out.push({ kind: 'ci', ...about(p), status: p.ci, ...(detail ? { detail } : {}) });
    }
    if (!mine.has(keyOf(p))) continue;
    // A review of theirs: each new one the lists carry, else a new decision.
    const seen = new Set(
      (old.reviews ?? []).map((r) => `${r.by.login}\n${r.state}\n${r.submittedAt ?? ''}`),
    );
    const added = (p.reviews ?? []).filter(
      (r) =>
        r.state !== 'dismissed' &&
        !seen.has(`${r.by.login}\n${r.state}\n${r.submittedAt ?? ''}`) &&
        fresh(r.submittedAt),
    );
    for (const r of added) {
      if (r.state === 'dismissed') continue;
      out.push({
        kind: 'review',
        ...about(p),
        by: (r.by.name ?? r.by.login).slice(0, 100),
        review: REVIEW_KIND[r.state],
      });
    }
    if (!p.reviews && old.review !== p.review && p.review && p.review !== 'Review requested') {
      out.push({
        kind: 'review',
        ...about(p),
        review: p.review === 'Approved' ? 'approved' : 'changes',
      });
    }
  }

  for (const p of after.recent ?? []) {
    if (p.state !== 'merged') continue;
    const old = was.get(keyOf(p));
    if (old?.state !== 'merged' && fresh(p.mergedAt)) out.push({ kind: 'merged', ...about(p) });
    const d = p.deploy;
    if (!d || (d.status !== 'pass' && d.status !== 'fail') || !fresh(d.at)) continue;
    const o = old?.deploy;
    if (o && o.status === d.status && o.at === d.at && o.environment === d.environment) continue;
    out.push({ kind: 'deploy', ...about(p), status: d.status, detail: d.environment });
  }
  return out;
}

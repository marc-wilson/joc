// The latest GitHub data per owner: their pull requests as their plugin last read them (the newest
// report from any of their machines wins), or, once the JOC GitHub App covers them, as its
// webhooks keep them (github-events.ts). One document per owner; an App-kept one is never
// overwritten by a plugin's report.
import { getDb } from '@joc/db';
import type { GitHubReport, GitHubSnapshot } from '@joc/protocol';
import { alertOnGitHub } from './alerts.ts';
import { publish } from './bus.ts';
import type { Owner } from './owner.ts';

type GitHubDoc = Omit<GitHubReport, 'at'> & {
  _id: string;
  reportedAt: number;
  updatedAt: Date;
  /** `app` once the GitHub App keeps it; a plugin's report otherwise. */
  source?: 'app';
};

type Lists = Pick<GitHubReport, 'reviewRequested' | 'mine'>;

const github = () => getDb().collection<GitHubDoc>('github');

/** Keeps the owner's newest report; an older one than stored is dropped. */
export async function saveGitHub(owner: Owner, { at, ...report }: GitHubReport): Promise<boolean> {
  let before: GitHubDoc | null;
  try {
    before = await github().findOneAndUpdate(
      { _id: owner, reportedAt: { $lt: at }, source: { $ne: 'app' } },
      { $set: { ...report, reportedAt: at, updatedAt: new Date() } },
      { upsert: true, returnDocument: 'before' },
    );
  } catch (error) {
    // A stale report, or one the App's data outranks: the filter missed and the upsert hit its _id.
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
      return false;
    }
    throw error;
  }
  // Only a nudge goes out; each dashboard fetches the snapshot.
  publish(owner, { type: 'github' });
  // News against the read before, and what this read resolves.
  await alertOnGitHub(owner, before, report);
  return true;
}

const same = (doc: GitHubDoc | null, lists: Lists) =>
  doc?.source === 'app' &&
  JSON.stringify([doc.reviewRequested, doc.mine]) ===
    JSON.stringify([lists.reviewRequested, lists.mine]);

/**
 * The owner's lists as the App's webhooks have them now. Their dashboards hear only of a change,
 * and its alerts are raised and resolved as a plugin's read would.
 */
export async function saveAppGitHub(owner: Owner, lists: Lists): Promise<void> {
  const before = await github().findOneAndUpdate(
    { _id: owner },
    {
      $set: {
        status: 'ok',
        ...lists,
        reportedAt: Date.now(),
        updatedAt: new Date(),
        source: 'app',
      },
    },
    { upsert: true, returnDocument: 'before' },
  );
  if (same(before, lists)) return;
  publish(owner, { type: 'github' });
  await alertOnGitHub(owner, before, { status: 'ok', ...lists });
}

/** The App no longer covers the owner: their plugin's next read starts afresh. */
export async function dropAppGitHub(owner: Owner): Promise<void> {
  const res = await github().deleteOne({ _id: owner, source: 'app' });
  if (res.deletedCount) publish(owner, { type: 'github' });
}

export async function getGitHub(owner: Owner): Promise<GitHubSnapshot> {
  const doc = await github().findOne({ _id: owner });
  if (!doc) return { state: 'none' };
  return {
    state: 'reported',
    status: doc.status,
    reviewRequested: doc.reviewRequested,
    mine: doc.mine,
    updatedAt: doc.updatedAt.toISOString(),
  };
}

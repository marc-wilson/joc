// The latest GitHub report per owner: their pull requests as their plugin last read them. One
// document per owner; the newest report from any of their machines wins.
import { getDb } from '@joc/db';
import type { GitHubReport, GitHubSnapshot } from '@joc/protocol';
import { alertOnGitHub } from './alerts.ts';
import { publish } from './bus.ts';
import type { Owner } from './owner.ts';

type GitHubDoc = Omit<GitHubReport, 'at'> & { _id: string; reportedAt: number; updatedAt: Date };

const github = () => getDb().collection<GitHubDoc>('github');

/** Keeps the owner's newest report; an older one than stored is dropped. */
export async function saveGitHub(owner: Owner, { at, ...report }: GitHubReport): Promise<boolean> {
  let before: GitHubDoc | null;
  try {
    before = await github().findOneAndUpdate(
      { _id: owner, reportedAt: { $lt: at } },
      { $set: { ...report, reportedAt: at, updatedAt: new Date() } },
      { upsert: true, returnDocument: 'before' },
    );
  } catch (error) {
    // A stale report: the filter missed a newer stored one and the upsert hit its _id.
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

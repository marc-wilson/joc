// The latest GitHub report per owner: their pull requests as their plugin last read them. One
// document per owner; the newest report from any of their machines wins.
import { EventEmitter } from 'node:events';
import { getDb } from '@joc/db';
import type { GitHubReport, GitHubSnapshot } from '@joc/protocol';
import { alertOnReviews } from './alerts.ts';
import type { Owner } from './owner.ts';

type GitHubDoc = Omit<GitHubReport, 'at'> & { _id: string; reportedAt: number; updatedAt: Date };

const github = () => getDb().collection<GitHubDoc>('github');

// Same per-owner, in-process fan-out as session updates (see sessions.ts). Only a nudge goes
// out; each dashboard fetches the snapshot.
const updates = new EventEmitter().setMaxListeners(0);

export function onGitHub(owner: Owner, listener: () => void): () => void {
  updates.on(`github:${owner}`, listener);
  return () => updates.off(`github:${owner}`, listener);
}

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
  updates.emit(`github:${owner}`);
  // Only news against a good earlier read: the first one, or one after `gh` failed, is the
  // starting point, not a burst of review requests.
  if (before?.status === 'ok' && report.status === 'ok') {
    await alertOnReviews(owner, before.reviewRequested, report.reviewRequested);
  }
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

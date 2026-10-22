// The latest GitHub data per owner: their pull requests as their plugin last read them (the newest
// report from any of their machines wins), or, once the JOC GitHub App covers them, as its
// webhooks keep them (github-events.ts). One document per owner; an App-kept one is never
// overwritten by a plugin's report.
import { getDb } from '@joc/db';
import { type GitHubReport, type GitHubSnapshot, PullRequest } from '@joc/protocol';
import { alertOnGitHub } from './alerts.ts';
import { publish } from './bus.ts';
import type { Owner } from './owner.ts';

type GitHubDoc = Omit<GitHubReport, 'at'> & {
  _id: string;
  reportedAt: number;
  updatedAt: Date;
  /** `app` once the GitHub App keeps it; a plugin's report otherwise. */
  source?: 'app';
  /** The App's only: the owner's pull requests that closed in the last day, for Operations. */
  recent?: PullRequest[];
  /** The App's only: the owner's repos that report deploys. */
  deployRepos?: string[];
};

type Lists = Pick<GitHubReport, 'reviewRequested' | 'mine'>;

/** What the App keeps beyond a plugin's lists. */
type AppLists = Lists & { recent: PullRequest[]; deployRepos: string[] };

const github = () => getDb().collection<GitHubDoc>('github');

/**
 * Each pull request a plugin's read brought, whole (description too), kept apart from the lists
 * so they stay light: a review session shows its pull request from here, also once it has left
 * the lists (a reviewer who reviewed is no longer asked). Keyed `owner/repo#number`, lower case.
 */
interface PullDetailsDoc {
  _id: string;
  owner: string;
  pull: PullRequest;
  /** When a read last brought a change to it. */
  keptAt: Date;
}

/** A copy no read has changed for this long is dropped. */
const DETAILS_KEPT_SECONDS = 90 * 24 * 60 * 60;

const details = () => getDb().collection<PullDetailsDoc>('github_pull_details');

let indexed: Promise<unknown> | undefined;
const ensureIndexes = () => {
  indexed ??= details().createIndex({ keptAt: 1 }, { expireAfterSeconds: DETAILS_KEPT_SECONDS });
  return indexed;
};

const detailsKey = (owner: Owner, repo: string, number: number) =>
  `${owner}/${repo.toLowerCase()}#${number}`;

/** A pull request as the lists keep it: without its description. */
const listed = ({ body: _b, bodyTruncated: _t, ...pull }: PullRequest): PullRequest => pull;

const lighten = (lists: Lists): Lists => ({
  reviewRequested: lists.reviewRequested.map(listed),
  mine: lists.mine.map(listed),
});

/** Keeps the whole copy of each pull request that changed since the owner's last read. */
async function keepDetails(owner: Owner, before: GitHubDoc | null, lists: Lists) {
  const seen = new Map(
    [...(before?.reviewRequested ?? []), ...(before?.mine ?? [])].map((p) => [
      `${p.repo.toLowerCase()}#${p.number}`,
      JSON.stringify(p),
    ]),
  );
  const changed = new Map<string, PullRequest>();
  for (const pull of [...lists.reviewRequested, ...lists.mine]) {
    const key = `${pull.repo.toLowerCase()}#${pull.number}`;
    if (seen.get(key) !== JSON.stringify(listed(pull))) changed.set(key, pull);
  }
  if (!changed.size) return;
  await ensureIndexes();
  const keptAt = new Date();
  await details().bulkWrite(
    [...changed.values()].map((pull) => ({
      replaceOne: {
        filter: { _id: detailsKey(owner, pull.repo, pull.number) },
        replacement: { owner, pull, keptAt },
        upsert: true,
      },
    })),
    { ordered: false },
  );
}

/** The owner's last whole copy of a pull request from their plugin's reads. */
export async function pullDetails(
  owner: Owner,
  repo: string,
  number: number,
): Promise<{ pull: PullRequest; readAt: string } | undefined> {
  const doc = await details().findOne({ _id: detailsKey(owner, repo, number), owner });
  if (!doc) return undefined;
  const pull = PullRequest.safeParse(doc.pull);
  return pull.success ? { pull: pull.data, readAt: doc.keptAt.toISOString() } : undefined;
}

/** Keeps the owner's newest report; an older one than stored is dropped. */
export async function saveGitHub(owner: Owner, { at, ...whole }: GitHubReport): Promise<boolean> {
  const report = { ...whole, ...lighten(whole) };
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
  await keepDetails(owner, before, whole);
  // Only a nudge goes out; each dashboard fetches the snapshot.
  publish(owner, { type: 'github' });
  // News against the read before, and what this read resolves.
  await alertOnGitHub(owner, before, report);
  return true;
}

const same = (doc: GitHubDoc | null, lists: AppLists) =>
  doc?.source === 'app' &&
  JSON.stringify([doc.reviewRequested, doc.mine, doc.recent ?? [], doc.deployRepos ?? []]) ===
    JSON.stringify([lists.reviewRequested, lists.mine, lists.recent, lists.deployRepos]);

/**
 * The owner's lists as the App's webhooks have them now. Their dashboards hear only of a change,
 * and its alerts are raised and resolved as a plugin's read would.
 */
export async function saveAppGitHub(owner: Owner, lists: AppLists): Promise<void> {
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
  const { reviewRequested, mine } = lists;
  await alertOnGitHub(owner, before, { status: 'ok', reviewRequested, mine });
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

/** Everything Operations builds its rows from: the lists, and what only the App keeps. */
export interface GitHubLists {
  snapshot: GitHubSnapshot;
  /** The owner's pull requests that closed lately, as the App heard. */
  recent: PullRequest[];
  deployRepos: string[];
}

export async function getGitHubLists(owner: Owner): Promise<GitHubLists> {
  const doc = await github().findOne({ _id: owner });
  if (!doc) return { snapshot: { state: 'none' }, recent: [], deployRepos: [] };
  return {
    snapshot: {
      state: 'reported',
      status: doc.status,
      reviewRequested: doc.reviewRequested,
      mine: doc.mine,
      updatedAt: doc.updatedAt.toISOString(),
    },
    recent: doc.source === 'app' ? (doc.recent ?? []) : [],
    deployRepos: doc.source === 'app' ? (doc.deployRepos ?? []) : [],
  };
}

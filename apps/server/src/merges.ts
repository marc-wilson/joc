// Operations' throughput (#114): the owner's pull requests that merged in the last MERGES_KEEP_MS,
// with when each first deployed and when the first session on its branch started. The App's
// lists keep closed pull requests for a day only (github-events.ts); each change to them is
// kept here, per owner, so a week of merges and deploys outlasts them.
import { getDb } from '@joc/db';
import { MERGES_KEEP_MS, type OperationMerge, type PullRequest } from '@joc/protocol';
import type { Owner } from './owner.ts';
import { firstSessionStart } from './sessions.ts';

interface MergeDoc {
  /** `owner/repo#number`, the repo lower case. */
  _id: string;
  owner: string;
  repo: string;
  number: number;
  branch: string;
  mergedAt: Date;
  deployedAt?: Date;
  sessionStartedAt?: Date;
}

const merges = () => getDb().collection<MergeDoc>('merges');

let indexed: Promise<unknown> | undefined;
const ensureIndexes = () => {
  indexed ??= Promise.all([
    merges().createIndex({ owner: 1, mergedAt: -1 }),
    merges().createIndex({ mergedAt: 1 }, { expireAfterSeconds: MERGES_KEEP_MS / 1000 }),
  ]);
  return indexed;
};

const keyOf = (owner: Owner, p: PullRequest) => `${owner}/${p.repo.toLowerCase()}#${p.number}`;

/** Keeps each merged pull request among the owner's recent ones, and its first good deploy. */
export async function keepMerges(owner: Owner, recent: PullRequest[]): Promise<void> {
  const merged = recent.filter(
    (p): p is PullRequest & { mergedAt: string } => p.state === 'merged' && !!p.mergedAt,
  );
  if (!merged.length) return;
  await ensureIndexes();
  const known = new Set(
    (
      await merges()
        .find(
          { _id: { $in: merged.map((p) => keyOf(owner, p)) }, owner },
          { projection: { _id: 1 } },
        )
        .toArray()
    ).map((d) => d._id),
  );
  const ops = [];
  for (const p of merged) {
    const _id = keyOf(owner, p);
    const mergedAt = new Date(p.mergedAt);
    // Only a session that started before the merge worked on it.
    const started = known.has(_id) ? undefined : await firstSessionStart(owner, p.repo, p.branch);
    const deployed = p.deploy?.status === 'pass' ? new Date(p.deploy.at) : undefined;
    ops.push({
      updateOne: {
        filter: { _id },
        update: {
          $set: { owner, repo: p.repo, number: p.number, branch: p.branch, mergedAt },
          ...(started && started < mergedAt ? { $setOnInsert: { sessionStartedAt: started } } : {}),
          ...(deployed ? { $min: { deployedAt: deployed } } : {}),
        },
        upsert: true,
      },
    });
  }
  await merges().bulkWrite(ops, { ordered: false });
}

/** The owner's merges within MERGES_KEEP_MS, newest first. */
export async function listMerges(owner: Owner, now = Date.now()): Promise<OperationMerge[]> {
  const docs = await merges()
    .find({ owner, mergedAt: { $gte: new Date(now - MERGES_KEEP_MS) } })
    .sort({ mergedAt: -1 })
    .limit(1000)
    .toArray();
  return docs.map((d) => ({
    repo: d.repo,
    number: d.number,
    mergedAt: d.mergedAt.toISOString(),
    ...(d.deployedAt ? { deployedAt: d.deployedAt.toISOString() } : {}),
    ...(d.sessionStartedAt ? { sessionStartedAt: d.sessionStartedAt.toISOString() } : {}),
  }));
}

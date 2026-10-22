// A review session's Changes: the pull request it reviews, not the branch its folder has checked
// out. Read through the JOC GitHub App (`GET /repos/{repo}/pulls/{n}/files`, which compares the
// head with its merge base, as GitHub's Files tab does) once per head commit, and kept per owner.
// Without the App, or where it doesn't reach the pull request, the tab says so; it never falls
// back to the folder's diff.
import { getDb } from '@joc/db';
import {
  MAX_DIFF_BYTES,
  MAX_PULL_DIFF_FILES,
  type PullDiffFile,
  type PullDiffMissing,
  type SessionChanges,
  type SessionReview,
} from '@joc/protocol';
import { z } from 'zod';
import {
  type Context,
  type ReviewedHead,
  readReviewedPull,
  reviewedHead,
} from './github-events.ts';
import type { Owner } from './owner.ts';

type PullChanges = Extract<SessionChanges, { source: 'pull' }>;

/** One page's file, as GitHub lists them. */
const ApiFile = z.object({
  filename: z.string(),
  previous_filename: z.string().nullish(),
  status: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  patch: z.string().nullish(),
});
type ApiFile = z.infer<typeof ApiFile>;

const PER_PAGE = 100;

const STATUS = new Map<string, PullDiffFile['status']>([
  ['added', 'added'],
  ['copied', 'added'],
  ['removed', 'deleted'],
  ['renamed', 'renamed'],
]);

/**
 * GitHub's files as the Changes tab shows them: at most MAX_DIFF_BYTES of patches in all, a file
 * whose patch doesn't fit in what's left listed without it. Truncated when any patch is cut, or GitHub listed fewer
 * files than the pull request changes (it lists 3000 at most).
 */
export function toDiffFiles(
  listed: ApiFile[],
  changedFiles?: number,
): { files: PullDiffFile[]; truncated: boolean } {
  let budget = MAX_DIFF_BYTES;
  let truncated = listed.length < (changedFiles ?? 0) || listed.length > MAX_PULL_DIFF_FILES;
  const files = listed.slice(0, MAX_PULL_DIFF_FILES).map((f): PullDiffFile => {
    const status = STATUS.get(f.status) ?? 'modified';
    const file: PullDiffFile = {
      path: f.filename.slice(0, 1000),
      status,
      additions: f.additions,
      deletions: f.deletions,
    };
    if (status === 'renamed' && f.previous_filename)
      file.oldPath = f.previous_filename.slice(0, 1000);
    if (f.patch) {
      const bytes = Buffer.byteLength(f.patch);
      if (bytes <= budget) {
        budget -= bytes;
        file.patch = f.patch;
      } else truncated = true;
    }
    return file;
  });
  return { files, truncated };
}

/** Every file of the pull request, page by page; undefined when GitHub doesn't answer. */
async function readFiles(ctx: Context, head: ReviewedHead): Promise<ApiFile[] | undefined> {
  const api = ctx.api;
  if (!api) return undefined;
  const all: ApiFile[] = [];
  for (let page = 1; page <= MAX_PULL_DIFF_FILES / PER_PAGE; page++) {
    const body = await api.get(
      head.installationId,
      `/repos/${head.repo}/pulls/${head.number}/files?per_page=${PER_PAGE}&page=${page}`,
    );
    const files = z.array(ApiFile).safeParse(body);
    if (!files.success) return undefined;
    all.push(...files.data);
    if (files.data.length < PER_PAGE) break;
  }
  return all;
}

interface PullDiffDoc {
  /** `owner/repo#number`, the repo in lower case. */
  _id: string;
  owner: string;
  repo: string;
  number: number;
  base: string;
  headSha: string;
  files: PullDiffFile[];
  truncated: boolean;
  readAt: Date;
}

/** A diff no review has looked at for this long is dropped. */
const KEPT_SECONDS = 30 * 24 * 60 * 60;

const diffs = () => getDb().collection<PullDiffDoc>('review_diffs');

let indexed: Promise<unknown> | undefined;
const ensureIndexes = () => {
  indexed ??= diffs().createIndex({ readAt: 1 }, { expireAfterSeconds: KEPT_SECONDS });
  return indexed;
};

const diffKey = (owner: Owner, repo: string, number: number) =>
  `${owner}/${repo.toLowerCase()}#${number}`;

const toChanges = (doc: PullDiffDoc): PullChanges => ({
  source: 'pull',
  repo: doc.repo,
  number: doc.number,
  base: doc.base,
  headSha: doc.headSha,
  files: doc.files,
  truncated: doc.truncated,
  updatedAt: doc.readAt.toISOString(),
});

/** Reads in flight, so a burst of tabs asks GitHub once. */
const reading = new Map<string, Promise<PullChanges | undefined>>();
/** Heads GitHub didn't answer for lately: not asked again for a minute. */
const failed = new Map<string, number>();
const FAILED_MS = 60_000;

async function readAndKeep(
  ctx: Context,
  owner: Owner,
  head: ReviewedHead,
): Promise<PullChanges | undefined> {
  const listed = await readFiles(ctx, head);
  if (!listed) return undefined;
  const { files, truncated } = toDiffFiles(listed, head.changedFiles);
  await ensureIndexes();
  const doc: PullDiffDoc = {
    _id: diffKey(owner, head.repo, head.number),
    owner,
    repo: head.repo,
    number: head.number,
    base: head.base,
    headSha: head.headSha,
    files,
    truncated,
    readAt: new Date(),
  };
  await diffs().replaceOne({ _id: doc._id, owner }, doc, { upsert: true });
  return toChanges(doc);
}

const unavailable = (review: SessionReview, reason: PullDiffMissing): SessionChanges => ({
  source: 'unavailable',
  repo: review.repo,
  number: review.number,
  reason,
});

/**
 * What a review session's Changes tab shows: the pull request's files at its head commit, read
 * once per head and kept for the owner; or why it can't, never the folder's diff.
 */
export async function reviewChanges(
  ctx: Context | undefined,
  owner: Owner,
  review: SessionReview,
): Promise<SessionChanges> {
  if (!ctx?.api) return unavailable(review, 'no-app');
  const { repo, number } = review;
  let head = await reviewedHead(owner, repo, number);
  if (!head) {
    // No event on it yet: read it once (readReviewedPull keeps that to once in a while). A failed
    // read leaves no head, which answers "not reached" just below.
    await readReviewedPull(ctx, owner, repo, number).catch(() => undefined);
    head = await reviewedHead(owner, repo, number);
  }
  if (!head) return unavailable(review, 'not-reached');

  const key = diffKey(owner, head.repo, head.number);
  const kept = await diffs().findOne({ _id: key, owner });
  if (kept && kept.headSha === head.headSha) return toChanges(kept);

  const attempt = `${key}@${head.headSha}`;
  const now = Date.now();
  for (const [k, at] of failed) if (now - at >= FAILED_MS) failed.delete(k);
  let read = reading.get(attempt);
  if (!read && !failed.has(attempt)) {
    // A GitHub that times out or a failed write: the same as GitHub not answering.
    read = readAndKeep(ctx, owner, head)
      .catch(() => undefined)
      .finally(() => reading.delete(attempt));
    reading.set(attempt, read);
  }
  const fresh = read && (await read);
  if (fresh) return fresh;
  failed.set(attempt, Date.now());
  return unavailable(review, 'unreadable');
}

// Operations (#111): every piece of work in flight, one row per piece of work, built per owner
// from nothing but their live Claude Code sessions and their GitHub lists.
//
// - A row is a session, a pull request, or both: a pull request joins the session on its repo
//   and head branch (a review session, the pull request it reviews). When several sessions are
//   on one branch, the most recently active one gets it.
// - Rows come oldest first, by when they arrived, so the dashboard can keep them in place.
// - A row needs you when Claude waits on you, or when your own pull request fails CI, conflicts,
//   has changes requested, or its merge failed to deploy.
// - A merged pull request has shipped once it deployed, or at once in a repo that reports no
//   deploys. Shipped and closed ones stay for a day, the same as ended sessions.
import {
  OPERATIONS_KEEP_MS,
  type OperationNeed,
  type OperationPull,
  type OperationReview,
  type OperationRow,
  type Operations,
  type PullRequest,
  type PullRequestPerson,
  QUIET_AFTER_MS,
  type Session,
} from '@joc/protocol';
import { type GitHubLists, getGitHubLists } from './github-data.ts';
import type { Owner } from './owner.ts';
import { listSessions } from './sessions.ts';

const UNTITLED = 'New session';

/** `owner/name` and a branch, as rows are joined: repo names ignore case, as GitHub's do. */
const workKey = (repo: string, branch: string) => `${repo.toLowerCase()}\n${branch}`;
const pullKey = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;

/** What the Claude cell says: the open question while Claude waits, else what it's doing. */
function activityOf(s: Session): string | undefined {
  if (s.state === 'needs' && s.waiting) {
    return s.waiting.kind === 'question'
      ? s.waiting.questions[0]?.question
      : `Allow ${s.waiting.tool}: ${s.waiting.summary}`;
  }
  return s.activity ?? s.lastWords;
}

const isQuiet = (s: Session, now: number) =>
  s.state !== 'offline' && now - Date.parse(s.updatedAt) > QUIET_AFTER_MS;

/** The review decision as the Review cell names it, and whom it shows. */
function reviewOf(pr: PullRequest): {
  review?: OperationReview;
  reviewers: PullRequestPerson[];
  reviewUrl?: string;
} {
  // Each reviewer's latest review that counts, oldest first.
  const latest = new Map<string, NonNullable<PullRequest['reviews']>[number]>();
  for (const r of pr.reviews ?? []) {
    if (r.state === 'dismissed') latest.delete(r.by.login);
    else latest.set(r.by.login, r);
  }
  const reviews = [...latest.values()];
  const url = [...reviews].reverse().find((r) => r.url)?.url;
  const by = (state: string) => reviews.filter((r) => r.state === state).map((r) => r.by);
  if (pr.review === 'Changes requested') {
    return { review: 'changes', reviewers: by('changes-requested'), reviewUrl: url };
  }
  if (pr.review === 'Approved') {
    return { review: 'approved', reviewers: by('approved'), reviewUrl: url };
  }
  if (reviews.length) {
    return { review: 'commented', reviewers: reviews.map((r) => r.by), reviewUrl: url };
  }
  if (pr.review === 'Review requested') {
    return { review: 'required', reviewers: pr.requestedReviewers ?? [] };
  }
  return { reviewers: [] };
}

/** A pull request as a row's stages show it. */
export function toOperationPull(pr: PullRequest, mine: boolean): OperationPull {
  const checks = pr.checks ?? [];
  const done = checks.filter((c) => c.status !== 'pending').length;
  // An older plugin sends only `9/14`.
  const [shownDone, shownTotal] = (pr.ciDetail ?? '').split('/').map(Number);
  const state =
    pr.state === 'merged' || pr.state === 'closed' ? pr.state : pr.draft ? 'draft' : 'open';
  return {
    number: pr.number,
    url: pr.url,
    state,
    author: pr.author,
    mine,
    additions: pr.additions,
    deletions: pr.deletions,
    ...(pr.base ? { base: pr.base } : {}),
    ci: pr.ci,
    checks: checks.length
      ? {
          total: checks.length,
          done,
          failing: checks.filter((c) => c.status === 'fail').map((c) => c.name),
        }
      : {
          total: Number.isFinite(shownTotal) ? (shownTotal as number) : 0,
          done: Number.isFinite(shownDone) ? (shownDone as number) : 0,
          failing: [],
        },
    ...reviewOf(pr),
    conflicts:
      state !== 'merged' &&
      state !== 'closed' &&
      (pr.mergeable === false || pr.mergeState === 'dirty'),
    ...(pr.mergedAt ? { mergedAt: pr.mergedAt } : {}),
    ...(pr.closedAt ? { closedAt: pr.closedAt } : {}),
    ...(pr.mergeCommit ? { mergeCommit: pr.mergeCommit } : {}),
    ...(pr.deploy ? { deploy: pr.deploy } : {}),
  };
}

/** Why the row needs you, most pressing first. */
export function needsOf(session: Session | undefined, pull: OperationPull | undefined) {
  const needs: OperationNeed[] = [];
  if (session?.state === 'needs') needs.push('answer');
  if (pull?.mine) {
    const live = pull.state === 'open' || pull.state === 'draft';
    if (live && pull.ci === 'fail') needs.push('ci');
    if (live && pull.conflicts) needs.push('conflicts');
    if (live && pull.review === 'changes') needs.push('review');
    if (pull.state === 'merged' && pull.deploy?.status === 'fail') needs.push('deploy');
  }
  return needs;
}

/** When it shipped: merged and deployed, or merged in a repo that reports no deploys. */
function shippedAt(pull: OperationPull | undefined, deploys: boolean): string | undefined {
  if (pull?.state !== 'merged') return undefined;
  if (!deploys) return pull.mergedAt ?? pull.closedAt;
  return pull.deploy?.status === 'pass' ? pull.deploy.at : undefined;
}

const latest = (...isos: (string | undefined)[]) =>
  isos.filter((t): t is string => !!t).reduce((a, b) => (a > b ? a : b));

export interface OperationsInput {
  sessions: Session[];
  github: GitHubLists;
  now?: number;
}

/** The owner's rows, oldest first. */
export function buildOperations({
  sessions,
  github,
  now = Date.now(),
}: OperationsInput): Operations {
  const { snapshot } = github;
  const deployRepos = new Set(github.deployRepos.map((r) => r.toLowerCase()));
  const keepFrom = new Date(now - OPERATIONS_KEEP_MS).toISOString();

  // Every pull request once: open ones as the lists have them, then the owner's closed ones.
  const pulls = new Map<string, { pr: PullRequest; mine: boolean }>();
  if (snapshot.state === 'reported') {
    for (const pr of snapshot.reviewRequested) {
      pulls.set(pullKey(pr.repo, pr.number), { pr, mine: false });
    }
    for (const pr of snapshot.mine) pulls.set(pullKey(pr.repo, pr.number), { pr, mine: true });
  }
  for (const pr of github.recent) {
    const key = pullKey(pr.repo, pr.number);
    // A closed one leaves after a day; an open copy in the lists is newer.
    if ((pr.closedAt ?? pr.updatedAt) < keepFrom || pulls.has(key)) continue;
    pulls.set(key, { pr, mine: true });
  }

  // Each branch's pull request: an open one over a closed one, else the latest.
  const onBranch = new Map<string, { pr: PullRequest; mine: boolean }>();
  for (const p of pulls.values()) {
    const key = workKey(p.pr.repo, p.pr.branch);
    const kept = onBranch.get(key);
    const open = (x: PullRequest) => (x.state ?? 'open') === 'open';
    if (
      !kept ||
      (open(p.pr) && !open(kept.pr)) ||
      (open(p.pr) === open(kept.pr) && p.pr.updatedAt > kept.pr.updatedAt)
    ) {
      onBranch.set(key, p);
    }
  }

  // Which session each pull request joins: the one reviewing it, else the most recently active
  // session on its branch.
  const joined = new Map<string, string>();
  const byActivity = [...sessions].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  for (const s of byActivity) {
    const p = s.review
      ? pulls.get(pullKey(s.review.repo, s.review.number))
      : s.branch
        ? onBranch.get(workKey(s.repo, s.branch))
        : undefined;
    if (!p) continue;
    const key = pullKey(p.pr.repo, p.pr.number);
    if (!joined.has(key)) joined.set(key, s.id);
  }
  const pullOf = new Map([...joined].map(([key, id]) => [id, key]));

  const rows: OperationRow[] = [];
  const row = (
    id: string,
    repo: string,
    title: string,
    branch: string | undefined,
    since: string,
    activeAt: string,
    session: Session | undefined,
    p: { pr: PullRequest; mine: boolean } | undefined,
  ) => {
    const pull = p && toOperationPull(p.pr, p.mine);
    const shipped = shippedAt(pull, deployRepos.has(repo.toLowerCase()));
    rows.push({
      id,
      repo,
      title,
      ...(branch ? { branch } : {}),
      since,
      activeAt,
      ...(session
        ? {
            session: {
              id: session.id,
              state: session.state,
              ...(activityOf(session) ? { activity: activityOf(session) } : {}),
              ...(isQuiet(session, now) ? { quiet: true } : {}),
            },
          }
        : {}),
      ...(pull ? { pull } : {}),
      needs: needsOf(session, pull),
      ...(shipped ? { shippedAt: shipped } : {}),
    });
  };

  for (const s of sessions) {
    const key = pullOf.get(s.id);
    const p = key ? pulls.get(key) : undefined;
    const sessionAt = s.activeAt ?? s.updatedAt;
    row(
      `s:${s.id}`,
      // The pull request's own spelling of the repo, so both group together.
      p?.pr.repo ?? s.repo,
      s.title ?? UNTITLED,
      s.branch ?? p?.pr.branch,
      s.startedAt,
      latest(sessionAt, p?.pr.updatedAt),
      s,
      p,
    );
  }
  const taken = new Set(joined.keys());
  for (const [key, p] of pulls) {
    if (taken.has(key)) continue;
    row(
      `pr:${p.pr.repo}#${p.pr.number}`,
      p.pr.repo,
      p.pr.title,
      p.pr.branch,
      p.pr.createdAt ?? p.pr.updatedAt,
      p.pr.updatedAt,
      undefined,
      p,
    );
  }
  rows.sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : a.id < b.id ? -1 : 1));

  return {
    rows,
    deployRepos: github.deployRepos,
    github:
      snapshot.state === 'reported'
        ? { state: 'reported', status: snapshot.status, updatedAt: snapshot.updatedAt }
        : { state: 'none' },
  };
}

/** The owner's Operations, as `GET /api/operations` answers it. */
export async function getOperations(owner: Owner, now = Date.now()): Promise<Operations> {
  const [sessions, github] = await Promise.all([listSessions(owner, now), getGitHubLists(owner)]);
  return buildOperations({ sessions, github, now });
}

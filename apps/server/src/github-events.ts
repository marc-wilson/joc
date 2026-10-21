// GitHub, as the JOC GitHub App hears it: webhook events (and a one-time backfill) kept as the
// pull requests they describe, then handed to each JOC user they concern as that owner's own
// GitHub data (github-data.ts) and alerts (alerts.ts).
//
// Two stores here belong to an installation, not to an owner: `github_installations` (who
// installed the App, on which repos) and `github_pulls` (the pull requests those repos' events
// describe). The only route that reads them is a person's own connection, and only the accounts
// of the installations that person reaches. They exist to work out whom an event concerns: the
// pull request's author, its requested reviewers (people, and the members of requested teams),
// and the people a comment mentions. Each of them who uses JOC and reaches the installation
// gets their lists rebuilt from their own pull requests, stored under their owner id, and a
// nudge on their own live streams. Nobody else hears anything.
import { getDb } from '@joc/db';
import {
  type CIStatus,
  MAX_PR_CHECKS,
  MAX_PR_FILES,
  PullRequest,
  type PullRequestCheck,
  type PullRequestFile,
} from '@joc/protocol';
import { z } from 'zod';
import { alertOnComment } from './alerts.ts';
import type { GitHubAppApi } from './github-app.ts';
import { dropAppGitHub, saveAppGitHub } from './github-data.ts';
import {
  type GitHubPerson,
  githubPerson,
  grantInstallation,
  peopleOfInstallation,
  peopleOnGitHub,
  revokeInstallation,
  type SeenInstallation,
} from './identity.ts';
import type { Owner } from './owner.ts';

// ── What GitHub sends: only the fields read, each checked ───────────────────

const Account = z.object({ id: z.number(), login: z.string() });
type Account = z.infer<typeof Account>;
const Installation = z.object({ id: z.number() });
const Repository = z.object({ full_name: z.string() });
const Team = z.object({ slug: z.string() });

const PullPayload = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  html_url: z.url(),
  state: z.string(),
  draft: z.boolean().nullish(),
  updated_at: z.string(),
  user: Account.nullish(),
  head: z.object({ ref: z.string(), sha: z.string() }),
  base: z.object({ ref: z.string() }),
  // A review's or comment's copy of the pull request leaves these out.
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  changed_files: z.number().int().nonnegative().optional(),
  requested_reviewers: z.array(Account.or(z.object({ slug: z.string() }))).optional(),
  requested_teams: z.array(Team).optional(),
});
type PullPayload = z.infer<typeof PullPayload>;

const Comment = z.object({
  id: z.number(),
  body: z.string().nullish(),
  html_url: z.url(),
  user: Account.nullish(),
});

const Check = z.object({
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullish(),
  started_at: z.string().nullish(),
  completed_at: z.string().nullish(),
  head_sha: z.string(),
  pull_requests: z.array(z.object({ number: z.number() })).optional(),
});

// ── The installation's stores ───────────────────────────────────────────────

interface InstallationDoc {
  _id: number;
  account: Account & { type: string };
  /** `all` repos of the account, or the `selected` ones in `repos`. */
  selection: string;
  repos: string[];
  suspended: boolean;
  updatedAt: Date;
}

interface CheckDoc extends PullRequestCheck {
  /** `run:<name>`, `status:<context>`, or a suite's or workflow's when it ran no check run. */
  key: string;
}

interface ReviewDoc {
  id: number;
  login: string;
  /** GitHub's, upper case: APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED. */
  state: string;
}

export interface PullDoc {
  /** `owner/name#number`. */
  _id: string;
  installationId: number;
  repo: string;
  number: number;
  title: string;
  url: string;
  branch: string;
  base: string;
  headSha: string;
  author: Account;
  draft: boolean;
  open: boolean;
  additions: number;
  deletions: number;
  changedFiles?: number;
  files?: PullRequestFile[];
  requested: Account[];
  teams: string[];
  /** Everyone asked for a review: requested people and the requested teams' members. */
  askedIds: number[];
  reviews: ReviewDoc[];
  checks: CheckDoc[];
  /** GitHub's `updated_at`: an older copy of the pull request than this one is dropped. */
  updatedAt: string;
}

const installations = () => getDb().collection<InstallationDoc>('github_installations');
const pulls = () => getDb().collection<PullDoc>('github_pulls');

let indexed: Promise<unknown> | undefined;
const ensureIndexes = () => {
  indexed ??= Promise.all([
    pulls().createIndex({ 'author.id': 1, open: 1 }),
    pulls().createIndex({ askedIds: 1, open: 1 }),
    pulls().createIndex({ repo: 1, headSha: 1 }),
    pulls().createIndex({ installationId: 1 }),
  ]);
  return indexed;
};

const pullKey = (repo: string, number: number) => `${repo}#${number}`;

// ── Who is covered ─────────────────────────────────────────────────────────

/** Whether the owner reaches a live installation, so the App, not their plugin, brings GitHub. */
const covered = new Map<Owner, { yes: boolean; at: number }>();
const COVERAGE_MS = 30_000;

export async function isCovered(owner: Owner): Promise<boolean> {
  const kept = covered.get(owner);
  if (kept && Date.now() - kept.at < COVERAGE_MS) return kept.yes;
  const person = await githubPerson(owner);
  const yes =
    !!person?.installations.length &&
    (await installations().countDocuments(
      { _id: { $in: person.installations }, suspended: false },
      { limit: 1 },
    )) > 0;
  covered.set(owner, { yes, at: Date.now() });
  return yes;
}

const forgetCoverage = () => covered.clear();

/** Asks afresh next time: the owner just signed in, so what they reach may have changed. */
export const forgetOwnerCoverage = (owner: Owner) => covered.delete(owner);

/**
 * Installations a person's sign-in saw, kept for any JOC hasn't heard of yet: one installed just
 * before the sign-in, whose webhook may still be on its way, or one from before the webhook was
 * set up. What a webhook said is never overwritten.
 */
export async function noteInstallations(seen: SeenInstallation[]) {
  if (!seen.length) return;
  await ensureIndexes();
  for (const i of seen) {
    await installations().updateOne(
      { _id: i.id },
      {
        $setOnInsert: {
          account: i.account,
          selection: i.selection,
          repos: [],
          suspended: i.suspended,
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
  }
  forgetCoverage();
}

/** The accounts of these installations (the ones a person reaches), for their own eyes only. */
export async function installationAccounts(ids: number[]) {
  if (!ids.length) return [];
  const docs = await installations()
    .find({ _id: { $in: ids } })
    .sort({ 'account.login': 1 })
    .toArray();
  return docs.map((d) => ({ id: d._id, account: d.account, suspended: d.suspended }));
}

// ── Turning the stores into each owner's lists ──────────────────────────────

const CHECK_STATUS = new Map<string, CIStatus>([
  ['success', 'pass'],
  ['neutral', 'skipped'],
  ['skipped', 'skipped'],
  ['stale', 'skipped'],
  ['failure', 'fail'],
  ['error', 'fail'],
  ['timed_out', 'fail'],
  ['cancelled', 'fail'],
  ['action_required', 'fail'],
  ['startup_failure', 'fail'],
]);

/** A check run's (or suite's) outcome as JOC's CI status: pending until it completed. */
export function runStatus(status: string, conclusion: string | null | undefined): CIStatus {
  if (status !== 'completed') return 'pending';
  return CHECK_STATUS.get(conclusion ?? '') ?? 'pending';
}

/** A commit status's state as JOC's CI status. */
const commitStatus = (state: string): CIStatus =>
  state === 'success' ? 'pass' : state === 'failure' || state === 'error' ? 'fail' : 'pending';

function seconds(started?: string | null, completed?: string | null) {
  const ran = started && completed ? Date.parse(completed) - Date.parse(started) : Number.NaN;
  return Number.isFinite(ran) && ran >= 0 ? { seconds: Math.round(ran / 1000) } : {};
}

/** The decision GitHub would show, from the reviews it sent: a change request wins. */
function decision(pull: PullDoc): PullRequest['review'] {
  const latest = new Map<number, string>();
  for (const r of pull.reviews) if (r.state !== 'COMMENTED') latest.set(r.id, r.state);
  const states = [...latest.values()];
  if (states.includes('CHANGES_REQUESTED')) return 'Changes requested';
  if (states.includes('APPROVED')) return 'Approved';
  if (pull.askedIds.length || pull.teams.length) return 'Review requested';
  return undefined;
}

/** Leaves out what's undefined: Mongo would store it as null, which the protocol refuses. */
const defined = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/** A stored pull request as the dashboard shows it, in the shape the plugin's reads have. */
export function toPullRequest(pull: PullDoc): PullRequest | undefined {
  const checks = pull.checks.slice(0, MAX_PR_CHECKS).map(({ key: _k, ...c }) => defined(c));
  const ci: CIStatus = !checks.length
    ? 'skipped'
    : checks.some((c) => c.status === 'fail')
      ? 'fail'
      : checks.some((c) => c.status === 'pending')
        ? 'pending'
        : 'pass';
  const passed = checks.filter((c) => c.status === 'pass' || c.status === 'skipped').length;
  const parsed = PullRequest.safeParse(
    defined({
      number: pull.number,
      title: pull.title.slice(0, 500),
      url: pull.url,
      repo: pull.repo,
      branch: pull.branch.slice(0, 300),
      author: pull.author.login,
      updatedAt: new Date(pull.updatedAt).toISOString(),
      draft: pull.draft,
      additions: pull.additions,
      deletions: pull.deletions,
      review: decision(pull),
      ci,
      ciDetail: checks.length ? `${passed}/${checks.length}` : undefined,
      checks: checks.length ? checks : undefined,
      base: pull.base.slice(0, 300),
      files: pull.files,
      changedFiles: pull.changedFiles,
    }),
  );
  return parsed.success ? defined(parsed.data) : undefined;
}

const toList = (docs: PullDoc[]) => docs.flatMap((d) => toPullRequest(d) ?? []);

/** Rebuilds one person's lists from the pull requests they wrote or are asked to review. */
async function refresh(person: GitHubPerson): Promise<void> {
  await ensureIndexes();
  const newest = { updatedAt: -1 } as const;
  const [mine, asked] = await Promise.all([
    pulls().find({ open: true, 'author.id': person.githubId }).sort(newest).limit(100).toArray(),
    pulls().find({ open: true, askedIds: person.githubId }).sort(newest).limit(100).toArray(),
  ]);
  await saveAppGitHub(person.owner, { reviewRequested: toList(asked), mine: toList(mine) });
}

/** The JOC users among these accounts who reach a live installation: the ones to tell. */
async function coveredPeople(by: { ids?: number[]; logins?: string[] }) {
  const people = await peopleOnGitHub(by);
  const out: GitHubPerson[] = [];
  for (const p of people) if (await isCovered(p.owner)) out.push(p);
  return out;
}

const concerned = (pull: PullDoc | null | undefined) =>
  pull ? [pull.author.id, ...pull.askedIds] : [];

// ── Events ─────────────────────────────────────────────────────────────────

export interface Context {
  /** Absent without the App's id and key: no team members, files or backfill then. */
  api?: GitHubAppApi;
}

/** A team's members' ids, cached for a few minutes; none when GitHub can't say. */
const teamCache = new Map<string, { ids: number[]; at: number }>();
const TEAM_MS = 10 * 60_000;

async function teamMembers(ctx: Context, installationId: number, org: string, slug: string) {
  const key = `${installationId}/${org}/${slug}`;
  const kept = teamCache.get(key);
  if (kept && Date.now() - kept.at < TEAM_MS) return kept.ids;
  const body = await ctx.api?.get(
    installationId,
    `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(slug)}/members?per_page=100`,
  );
  const members = z.array(Account).safeParse(body);
  const ids = members.success ? members.data.map((m) => m.id) : [];
  teamCache.set(key, { ids, at: Date.now() });
  return ids;
}

const FILE_STATUS = new Map<string, PullRequestFile['status']>([
  ['added', 'added'],
  ['removed', 'deleted'],
  ['renamed', 'renamed'],
]);

const ApiFile = z.object({
  filename: z.string(),
  status: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});

/** The pull request's first files, through the App; undefined when GitHub can't say. */
async function filesOf(ctx: Context, pull: PullDoc): Promise<PullRequestFile[] | undefined> {
  const body = await ctx.api?.get(
    pull.installationId,
    `/repos/${pull.repo}/pulls/${pull.number}/files?per_page=${MAX_PR_FILES}`,
  );
  const files = z.array(ApiFile).safeParse(body);
  if (!files.success) return undefined;
  return files.data.slice(0, MAX_PR_FILES).map((f) => ({
    path: f.filename.slice(0, 1000),
    status: FILE_STATUS.get(f.status) ?? 'modified',
    additions: f.additions,
    deletions: f.deletions,
  }));
}

/**
 * Keeps GitHub's copy of a pull request, unless an older one than stored. A new head commit
 * starts its CI afresh. Returns the stored pull request before and after.
 */
async function savePull(
  ctx: Context,
  installationId: number,
  repo: string,
  pr: PullPayload,
  merged: boolean | undefined = undefined,
): Promise<{ before: PullDoc | null; after: PullDoc | null }> {
  await ensureIndexes();
  const _id = pullKey(repo, pr.number);
  const before = await pulls().findOne({ _id });
  if (before && Date.parse(before.updatedAt) > Date.parse(pr.updated_at)) {
    return { before, after: before };
  }
  const people = (pr.requested_reviewers ?? []).flatMap((r) => ('login' in r ? [r] : []));
  const teams = [
    ...new Set([
      ...(pr.requested_teams ?? []).map((t) => t.slug),
      ...(pr.requested_reviewers ?? []).flatMap((r) => ('slug' in r ? [r.slug] : [])),
    ]),
  ];
  const org = repo.split('/')[0] ?? '';
  const members = (
    await Promise.all(teams.map((slug) => teamMembers(ctx, installationId, org, slug)))
  ).flat();
  const author = pr.user ?? { id: 0, login: 'ghost' };
  const sameHead = before?.headSha === pr.head.sha;
  const after: PullDoc = {
    _id,
    installationId,
    repo,
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    branch: pr.head.ref,
    base: pr.base.ref,
    headSha: pr.head.sha,
    author: { id: author.id, login: author.login },
    draft: pr.draft === true,
    open: pr.state === 'open' && merged !== true,
    additions: pr.additions ?? before?.additions ?? 0,
    deletions: pr.deletions ?? before?.deletions ?? 0,
    ...defined({
      changedFiles: pr.changed_files ?? before?.changedFiles,
      files: sameHead ? before?.files : undefined,
    }),
    requested: people.map((p) => ({ id: p.id, login: p.login })),
    teams,
    // The author never reviews their own.
    askedIds: [...new Set([...people.map((p) => p.id), ...members])].filter(
      (id) => id !== author.id,
    ),
    reviews: before?.reviews ?? [],
    checks: sameHead ? (before?.checks ?? []) : [],
    updatedAt: new Date(pr.updated_at).toISOString(),
  };
  if (after.open && !after.files) {
    const files = await filesOf(ctx, after);
    if (files) after.files = files;
  }
  await pulls().replaceOne({ _id }, after, { upsert: true });
  return { before, after };
}

/** Tells everyone a pull request concerns, before and after the change. */
async function tell(ids: number[]) {
  for (const person of await coveredPeople({ ids })) await refresh(person);
}

const PullEvent = z.object({
  action: z.string(),
  installation: Installation,
  repository: Repository,
  pull_request: PullPayload.extend({ merged: z.boolean().nullish() }),
});

async function onPullRequest(ctx: Context, payload: unknown) {
  const event = PullEvent.safeParse(payload);
  if (!event.success) return;
  const { installation, repository, pull_request: pr } = event.data;
  const { before, after } = await savePull(
    ctx,
    installation.id,
    repository.full_name,
    pr,
    pr.merged === true,
  );
  await tell([...concerned(before), ...concerned(after)]);
}

const ReviewEvent = z.object({
  action: z.string(),
  installation: Installation,
  repository: Repository,
  review: z.object({
    id: z.number(),
    state: z.string(),
    body: z.string().nullish(),
    html_url: z.url(),
    user: Account.nullish(),
  }),
  pull_request: PullPayload,
});

async function onReview(ctx: Context, payload: unknown) {
  const event = ReviewEvent.safeParse(payload);
  if (!event.success) return;
  const { action, installation, repository, review, pull_request: pr } = event.data;
  const repo = repository.full_name;
  // The review's copy of the pull request has who's still asked: a reviewer who reviewed isn't.
  const { before, after } = await savePull(ctx, installation.id, repo, pr);
  const state = action === 'dismissed' ? 'DISMISSED' : review.state.toUpperCase();
  // A comment-only review leaves the reviewer's decision as it was.
  const by = review.user;
  if (after && by && state !== 'COMMENTED') {
    const reviews = [
      ...after.reviews.filter((r) => r.id !== by.id),
      { id: by.id, login: by.login, state },
    ].slice(-100);
    await pulls().updateOne({ _id: after._id }, { $set: { reviews } });
  }
  await tell([...concerned(before), ...concerned(after)]);
  // A review on your pull request by someone else is news, as are the people it mentions.
  if (action === 'submitted' && review.user) {
    await commentNews({
      repo,
      number: pr.number,
      title: pr.title,
      url: review.html_url,
      by: review.user,
      body: review.body ?? '',
      author: pr.user ?? undefined,
    });
  }
}

/** `@login` mentions in a comment's text, outside code; `@org/team` mentions are left out. */
export function mentions(body: string): string[] {
  const text = body.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
  const found = new Set<string>();
  for (const [, login] of text.matchAll(
    /(?:^|[^\w/@.-])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?![\w/-])/g,
  )) {
    if (login) found.add(login.toLowerCase());
  }
  return [...found];
}

interface CommentNews {
  repo: string;
  number: number;
  title: string;
  url: string;
  by: Account;
  body: string;
  /** The pull request's or issue's author, who hears of comments on it. */
  author?: Account;
}

/** A comment's alerts: a mention for everyone it names, a comment for the author. */
async function commentNews(news: CommentNews) {
  const named = mentions(news.body).filter((l) => l !== news.by.login.toLowerCase());
  const author = news.author && news.author.id !== news.by.id ? news.author : undefined;
  const people = await coveredPeople({ logins: named, ids: author ? [author.id] : [] });
  const about = { title: news.title, repo: news.repo, number: news.number, url: news.url };
  for (const person of people) {
    const mentioned = named.includes(person.login.toLowerCase());
    if (!mentioned && person.githubId !== author?.id) continue;
    await alertOnComment(person.owner, {
      kind: mentioned ? 'mention' : 'comment',
      detail: news.by.login,
      ...about,
    });
  }
}

const IssueCommentEvent = z.object({
  action: z.string(),
  repository: Repository,
  issue: z.object({
    number: z.number().int().positive(),
    title: z.string(),
    user: Account.nullish(),
  }),
  comment: Comment,
});

async function onIssueComment(payload: unknown) {
  const event = IssueCommentEvent.safeParse(payload);
  if (!event.success || event.data.action !== 'created' || !event.data.comment.user) return;
  const { repository, issue, comment } = event.data;
  await commentNews({
    repo: repository.full_name,
    number: issue.number,
    title: issue.title,
    url: comment.html_url,
    by: comment.user ?? { id: 0, login: 'ghost' },
    body: comment.body ?? '',
    author: issue.user ?? undefined,
  });
}

const ReviewCommentEvent = z.object({
  action: z.string(),
  repository: Repository,
  pull_request: z.object({
    number: z.number().int().positive(),
    title: z.string(),
    user: Account.nullish(),
  }),
  comment: Comment,
});

async function onReviewComment(payload: unknown) {
  const event = ReviewCommentEvent.safeParse(payload);
  if (!event.success || event.data.action !== 'created' || !event.data.comment.user) return;
  const { repository, pull_request: pr, comment } = event.data;
  await commentNews({
    repo: repository.full_name,
    number: pr.number,
    title: pr.title,
    url: comment.html_url,
    by: comment.user ?? { id: 0, login: 'ghost' },
    body: comment.body ?? '',
    author: pr.user ?? undefined,
  });
}

/**
 * Sets one check on the open pull requests whose head is `sha`, and tells whom they concern. A
 * suite's or workflow's result counts only for a commit no check run reported on.
 */
async function setCheck(repo: string, sha: string, check: CheckDoc, fallback = false) {
  await ensureIndexes();
  const found = await pulls().find({ repo, headSha: sha, open: true }).toArray();
  const ids: number[] = [];
  for (const pull of found) {
    if (fallback && pull.checks.some((c) => c.key.startsWith('run:'))) continue;
    const checks = [...pull.checks.filter((c) => c.key !== check.key), check].slice(-MAX_PR_CHECKS);
    await pulls().updateOne({ _id: pull._id, headSha: sha }, { $set: { checks } });
    ids.push(...concerned(pull));
  }
  await tell(ids);
}

const CheckRunEvent = z.object({ repository: Repository, check_run: Check });

async function onCheckRun(payload: unknown) {
  const event = CheckRunEvent.safeParse(payload);
  if (!event.success) return;
  const { repository, check_run: run } = event.data;
  await setCheck(repository.full_name, run.head_sha, {
    key: `run:${run.name}`,
    name: run.name.slice(0, 200),
    status: runStatus(run.status, run.conclusion),
    ...seconds(run.started_at, run.completed_at),
  });
}

const CheckSuiteEvent = z.object({
  action: z.string(),
  repository: Repository,
  check_suite: z.object({
    head_sha: z.string(),
    status: z.string().nullish(),
    conclusion: z.string().nullish(),
    app: z.object({ name: z.string() }).nullish(),
  }),
});

async function onCheckSuite(payload: unknown) {
  const event = CheckSuiteEvent.safeParse(payload);
  if (!event.success || event.data.action !== 'completed') return;
  const { repository, check_suite: suite } = event.data;
  const name = suite.app?.name ?? 'Checks';
  await setCheck(
    repository.full_name,
    suite.head_sha,
    {
      key: `suite:${name}`,
      name: name.slice(0, 200),
      status: runStatus('completed', suite.conclusion),
    },
    true,
  );
}

const WorkflowRunEvent = z.object({
  action: z.string(),
  repository: Repository,
  workflow_run: z.object({
    name: z.string().nullish(),
    head_sha: z.string(),
    status: z.string().nullish(),
    conclusion: z.string().nullish(),
    run_started_at: z.string().nullish(),
    updated_at: z.string().nullish(),
  }),
});

async function onWorkflowRun(payload: unknown) {
  const event = WorkflowRunEvent.safeParse(payload);
  if (!event.success || event.data.action !== 'completed') return;
  const { repository, workflow_run: run } = event.data;
  const name = run.name || 'Workflow';
  await setCheck(
    repository.full_name,
    run.head_sha,
    {
      key: `workflow:${name}`,
      name: name.slice(0, 200),
      status: runStatus('completed', run.conclusion),
      ...seconds(run.run_started_at, run.updated_at),
    },
    true,
  );
}

const StatusEvent = z.object({
  repository: Repository,
  sha: z.string(),
  context: z.string(),
  state: z.string(),
});

async function onStatus(payload: unknown) {
  const event = StatusEvent.safeParse(payload);
  if (!event.success) return;
  const { repository, sha, context, state } = event.data;
  await setCheck(repository.full_name, sha, {
    key: `status:${context}`,
    name: context.slice(0, 200),
    status: commitStatus(state),
  });
}

// ── Installations ──────────────────────────────────────────────────────────

const InstallationEvent = z.object({
  action: z.string(),
  installation: z.object({
    id: z.number(),
    account: Account.extend({ type: z.string() }).nullish(),
    repository_selection: z.string().optional(),
  }),
  repositories: z.array(Repository).optional(),
  repositories_added: z.array(Repository).optional(),
  repositories_removed: z.array(Repository).optional(),
  sender: Account.optional(),
});

/** The org's members' ids, through the App (it needs Members: read); none when GitHub can't say. */
async function orgMembers(ctx: Context, installationId: number, org: string) {
  const ids: number[] = [];
  for (let page = 1; page <= 10; page++) {
    const body = await ctx.api?.get(
      installationId,
      `/orgs/${encodeURIComponent(org)}/members?per_page=100&page=${page}`,
    );
    const members = z.array(Account).safeParse(body);
    if (!members.success) break;
    ids.push(...members.data.map((m) => m.id));
    if (members.data.length < 100) break;
  }
  return ids;
}

/** Drops what an installation (or some of its repos) brought, and retells whom it concerned. */
async function forgetPulls(installationId: number, repos?: string[]) {
  const filter = { installationId, ...(repos ? { repo: { $in: repos } } : {}) };
  const gone = await pulls().find(filter).toArray();
  await pulls().deleteMany(filter);
  await tell(gone.flatMap(concerned));
}

async function onInstallation(ctx: Context, name: string, payload: unknown) {
  const event = InstallationEvent.safeParse(payload);
  if (!event.success) return;
  const { action, installation, sender } = event.data;
  const id = installation.id;
  if (name === 'installation' && action === 'deleted') {
    const people = await peopleOfInstallation(id);
    await installations().deleteOne({ _id: id });
    await revokeInstallation(id);
    forgetCoverage();
    await forgetPulls(id);
    // No longer covered: their plugin reads GitHub again, onto a clean slate.
    for (const p of people) if (!(await isCovered(p.owner))) await dropAppGitHub(p.owner);
    return;
  }
  const before = await installations().findOne({ _id: id });
  const added = (event.data.repositories_added ?? event.data.repositories ?? []).map(
    (r) => r.full_name,
  );
  const removed = (event.data.repositories_removed ?? []).map((r) => r.full_name);
  const repos =
    name === 'installation' && action === 'created'
      ? added
      : [...new Set([...(before?.repos ?? []), ...added])].filter((r) => !removed.includes(r));
  const account = installation.account ?? before?.account;
  if (!account) return;
  await installations().replaceOne(
    { _id: id },
    {
      account: { id: account.id, login: account.login, type: account.type },
      selection: installation.repository_selection ?? before?.selection ?? 'selected',
      repos,
      suspended: action === 'suspend' ? true : action === 'unsuspend' ? false : !!before?.suspended,
      updatedAt: new Date(),
    },
    { upsert: true },
  );
  forgetCoverage();
  if (removed.length) await forgetPulls(id, removed);
  if (action === 'suspend') return;
  if (action === 'created' || action === 'unsuspend' || added.length) {
    // Who reaches it: the account itself, or the org's members, and whoever installed it.
    const ids =
      account.type === 'Organization' ? await orgMembers(ctx, id, account.login) : [account.id];
    await grantInstallation([...ids, ...(sender ? [sender.id] : [])], id);
    forgetCoverage();
    for (const person of await peopleOfInstallation(id)) await backfill(ctx, person, [id]);
  }
}

// ── The one-time backfill ───────────────────────────────────────────────────

const Search = z.object({
  items: z.array(z.object({ number: z.number(), repository_url: z.string() })),
});
const ApiReview = z.object({ user: Account.nullish(), state: z.string() });
const ApiRuns = z.object({
  check_runs: z.array(Check.omit({ head_sha: true, pull_requests: true })),
});
const ApiStatus = z.object({
  statuses: z.array(z.object({ context: z.string(), state: z.string() })),
});

/** Reads one pull request whole, as webhooks would have built it: its reviews and CI too. */
async function readPull(ctx: Context, installationId: number, repo: string, number: number) {
  const api = ctx.api;
  if (!api) return;
  const pr = PullPayload.extend({ merged: z.boolean().nullish() }).safeParse(
    await api.get(installationId, `/repos/${repo}/pulls/${number}`),
  );
  if (!pr.success) return;
  const { after } = await savePull(ctx, installationId, repo, pr.data, pr.data.merged === true);
  if (!after) return;
  const sha = after.headSha;
  const [reviews, runs, status] = await Promise.all([
    api.get(installationId, `/repos/${repo}/pulls/${number}/reviews?per_page=100`),
    api.get(installationId, `/repos/${repo}/commits/${sha}/check-runs?per_page=100`),
    api.get(installationId, `/repos/${repo}/commits/${sha}/status`),
  ]);
  const r = z.array(ApiReview).safeParse(reviews);
  const c = ApiRuns.safeParse(runs);
  const s = ApiStatus.safeParse(status);
  const checks: CheckDoc[] = [
    ...(c.success ? c.data.check_runs : []).map((run) => ({
      key: `run:${run.name}`,
      name: run.name.slice(0, 200),
      status: runStatus(run.status, run.conclusion),
      ...seconds(run.started_at, run.completed_at),
    })),
    ...(s.success ? s.data.statuses : []).map((st) => ({
      key: `status:${st.context}`,
      name: st.context.slice(0, 200),
      status: commitStatus(st.state),
    })),
  ];
  await pulls().updateOne(
    { _id: after._id },
    {
      $set: {
        reviews: (r.success ? r.data : []).flatMap((x) =>
          x.user ? [{ id: x.user.id, login: x.user.login, state: x.state.toUpperCase() }] : [],
        ),
        checks: [...new Map(checks.map((k) => [k.key, k])).values()].slice(0, MAX_PR_CHECKS),
      },
    },
  );
}

/**
 * Reads the person's open pull requests once from GitHub, through the installations given (or
 * all they reach): when they sign in, or the App is installed where they are. Not polling: from
 * then on, webhooks keep them current.
 */
export async function backfill(ctx: Context, person: GitHubPerson, ids = person.installations) {
  if (ctx.api) {
    for (const installationId of ids) {
      for (const q of [`author:${person.login}`, `review-requested:${person.login}`]) {
        const query = encodeURIComponent(`is:pr is:open archived:false ${q}`);
        const found = Search.safeParse(
          await ctx.api.get(installationId, `/search/issues?q=${query}&per_page=50`),
        );
        for (const item of found.success ? found.data.items : []) {
          const repo = item.repository_url.match(/\/repos\/([^/]+\/[^/]+)$/)?.[1];
          if (repo) await readPull(ctx, installationId, repo, item.number);
        }
      }
    }
  }
  await refresh(person);
}

/** After a sign-in: the owner's lists, read once, if the App covers them. */
export async function backfillOwner(ctx: Context, owner: Owner) {
  forgetOwnerCoverage(owner);
  if (!(await isCovered(owner))) return;
  const person = await githubPerson(owner);
  if (person) await backfill(ctx, person);
}

// ── Dispatch ───────────────────────────────────────────────────────────────

/** Handles one verified webhook delivery. Events JOC doesn't use are ignored. */
export async function handleEvent(ctx: Context, name: string, payload: unknown): Promise<void> {
  switch (name) {
    case 'pull_request':
      return onPullRequest(ctx, payload);
    case 'pull_request_review':
      return onReview(ctx, payload);
    case 'pull_request_review_comment':
      return onReviewComment(payload);
    case 'issue_comment':
      return onIssueComment(payload);
    case 'check_run':
      return onCheckRun(payload);
    case 'check_suite':
      return onCheckSuite(payload);
    case 'workflow_run':
      return onWorkflowRun(payload);
    case 'status':
      return onStatus(payload);
    case 'installation':
    case 'installation_repositories':
      return onInstallation(ctx, name, payload);
  }
}

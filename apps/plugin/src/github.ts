// Open pull requests for the person signed in to `gh` on this machine: the ones waiting on their
// review and their own, with CI. Read through `gh`, so GitHub credentials never leave the
// machine. One machine-wide read a minute at most, whichever session's sync gets there first.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  GitHubReport,
  PullRequest,
  PullRequestCheck,
  PullRequestFile,
  PullRequestPerson,
  PullRequestReview,
} from '@joc/protocol';

/**
 * The most checks sent per pull request: @joc/protocol's MAX_PR_CHECKS, copied because an installed
 * plugin has no node_modules (github.test.ts keeps the two equal).
 */
export const MAX_PR_CHECKS = 50;

const EVERY_MS = 60_000;
const stampFile = () => join(homedir(), '.claude', 'joc', 'github-read-at');

/** True at most once a minute across every session on this machine. Claims the slot when true. */
export function githubDue(now = Date.now(), file = stampFile()): boolean {
  let last = 0;
  try {
    last = Number(readFileSync(file, 'utf8')) || 0;
  } catch {
    // Never read before.
  }
  if (now - last < EVERY_MS) return false;
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, String(now));
  return true;
}

/**
 * The most kept of a description, and of each list a review shows: @joc/protocol's limits, copied
 * for the same reason (github.test.ts keeps them equal).
 */
export const MAX_PR_BODY = 20_000;
export const MAX_PR_REVIEWS = 50;
export const MAX_PR_REVIEWERS = 50;
export const MAX_PR_LABELS = 50;
export const MAX_PR_CLOSES = 20;

const ACTOR = '__typename login avatarUrl ... on User { name }';

const PR_FIELDS = `
  ... on PullRequest {
    number title url isDraft additions deletions reviewDecision updatedAt headRefName baseRefName
    state createdAt body headRefOid mergeable
    changedFiles files(first: 100) { nodes { path additions deletions changeType } }
    repository { nameWithOwner }
    author { ${ACTOR} }
    reviews(last: ${MAX_PR_REVIEWS}) { nodes { state submittedAt url author { ${ACTOR} } } }
    reviewRequests(first: ${MAX_PR_REVIEWERS}) { nodes { requestedReviewer {
      __typename ... on User { login name avatarUrl } ... on Team { slug name }
    } } }
    labels(first: ${MAX_PR_LABELS}) { nodes { name color } }
    milestone { title number url dueOn }
    closingIssuesReferences(first: ${MAX_PR_CLOSES}) {
      nodes { number title url repository { nameWithOwner } }
    }
    commits(last: 1) { totalCount nodes { commit { statusCheckRollup { state contexts(first: ${MAX_PR_CHECKS}) {
      totalCount
      checkRunCountsByState { state count }
      statusContextCountsByState { state count }
      nodes {
        ... on CheckRun { name status conclusion startedAt completedAt }
        ... on StatusContext { context state }
      }
    } } } } }
  }`;

const QUERY = `query {
  review: search(query: "is:pr is:open review-requested:@me archived:false", type: ISSUE, first: 50) { nodes { ${PR_FIELDS} } }
  mine: search(query: "is:pr is:open author:@me archived:false", type: ISSUE, first: 50) { nodes { ${PR_FIELDS} } }
}`;

// The slice of GitHub's GraphQL answer this reads. It's external input: every field is checked.
interface Count {
  state?: string;
  count?: number;
}
/** One check on a commit: a check run (`name`) or a commit status (`context`). */
export interface GraphCheck {
  name?: string;
  status?: string;
  conclusion?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  context?: string;
  state?: string;
}

/** A commit's combined CI result, as GitHub's GraphQL API reports it. */
export type Rollup = {
  state?: string;
  contexts?: {
    totalCount?: number;
    checkRunCountsByState?: Count[];
    statusContextCountsByState?: Count[];
    nodes?: GraphCheck[];
  };
} | null;

export interface GraphFile {
  path?: string;
  additions?: number;
  deletions?: number;
  changeType?: string;
}

/** A user, bot or other account, as GitHub's GraphQL API names it. */
export interface GraphActor {
  __typename?: string;
  login?: string;
  name?: string | null;
  avatarUrl?: string;
}

export interface GraphNode {
  number?: number;
  title?: string;
  url?: string;
  isDraft?: boolean;
  additions?: number;
  deletions?: number;
  reviewDecision?: string | null;
  updatedAt?: string;
  headRefName?: string;
  baseRefName?: string;
  state?: string;
  createdAt?: string;
  body?: string | null;
  headRefOid?: string;
  mergeable?: string;
  changedFiles?: number;
  files?: { nodes?: GraphFile[] } | null;
  repository?: { nameWithOwner?: string };
  author?: GraphActor | null;
  reviews?: {
    nodes?: ({
      state?: string;
      submittedAt?: string | null;
      url?: string;
      author?: GraphActor | null;
    } | null)[];
  } | null;
  reviewRequests?: {
    nodes?: ({ requestedReviewer?: (GraphActor & { slug?: string }) | null } | null)[];
  } | null;
  labels?: { nodes?: ({ name?: string; color?: string } | null)[] } | null;
  milestone?: { title?: string; number?: number; url?: string; dueOn?: string | null } | null;
  closingIssuesReferences?: {
    nodes?: ({
      number?: number;
      title?: string;
      url?: string;
      repository?: { nameWithOwner?: string };
    } | null)[];
  } | null;
  commits?: { totalCount?: number; nodes?: { commit?: { statusCheckRollup?: Rollup } }[] };
}

const REVIEW = new Map<string, PullRequest['review']>([
  ['APPROVED', 'Approved'],
  ['CHANGES_REQUESTED', 'Changes requested'],
  ['REVIEW_REQUIRED', 'Review requested'],
]);

const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

/** GitHub's change types, as JOC shows them; COPIED and CHANGED read as modified. */
const CHANGE = new Map<string, PullRequestFile['status']>([
  ['ADDED', 'added'],
  ['DELETED', 'deleted'],
  ['RENAMED', 'renamed'],
]);

/** A check run's conclusion, or a commit status's state, as JOC's CI status. */
const CHECK = new Map<string, PullRequestCheck['status']>([
  ['SUCCESS', 'pass'],
  ['NEUTRAL', 'skipped'],
  ['SKIPPED', 'skipped'],
  ['STALE', 'skipped'],
  ['FAILURE', 'fail'],
  ['ERROR', 'fail'],
  ['TIMED_OUT', 'fail'],
  ['CANCELLED', 'fail'],
  ['ACTION_REQUIRED', 'fail'],
  ['STARTUP_FAILURE', 'fail'],
]);

/** The commit's checks GitHub listed, each checked; one without a name is dropped. */
export function toChecks(nodes: GraphCheck[] | undefined): PullRequestCheck[] | undefined {
  if (!Array.isArray(nodes)) return undefined;
  return nodes.slice(0, MAX_PR_CHECKS).flatMap((c) => {
    const name = c?.name ?? c?.context;
    if (typeof name !== 'string' || !name) return [];
    // A check run is done once it's COMPLETED; a status once it's left PENDING or EXPECTED.
    const outcome = c.name ? (c.status === 'COMPLETED' ? c.conclusion : undefined) : c.state;
    const status = (outcome && CHECK.get(outcome)) || 'pending';
    const ran =
      c.startedAt && c.completedAt ? Date.parse(c.completedAt) - Date.parse(c.startedAt) : NaN;
    return [
      {
        name: name.slice(0, 200),
        status,
        ...(Number.isFinite(ran) && ran >= 0 ? { seconds: Math.round(ran / 1000) } : {}),
      },
    ];
  });
}

const count = (n: unknown) => (typeof n === 'number' && n >= 0 ? Math.floor(n) : 0);

/** The PR's changed files GitHub listed, each checked; one without a path is dropped. */
function toFiles(nodes: GraphFile[] | undefined): PullRequestFile[] | undefined {
  if (!Array.isArray(nodes)) return undefined;
  return nodes.flatMap((f) =>
    typeof f?.path === 'string' && f.path
      ? [
          {
            path: f.path.slice(0, 1000),
            status: CHANGE.get(f.changeType ?? '') ?? 'modified',
            additions: count(f.additions),
            deletions: count(f.deletions),
          },
        ]
      : [],
  );
}

// What a review shows. The server refuses a whole report over one bad field, so each is checked
// here as @joc/protocol checks it, and one that doesn't fit is left out.

/** Leaves out what's undefined. */
const clean = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

const text = (v: unknown, max: number) =>
  typeof v === 'string' && v ? v.slice(0, max) : undefined;

const link = (v: unknown) =>
  typeof v === 'string' && v.length <= 500 && /^https?:\/\//.test(v) && URL.canParse(v)
    ? v
    : undefined;

const AVATAR = /^https:\/\/avatars\.githubusercontent\.com\//;
const avatar = (v: unknown) => {
  const url = link(v);
  return url && AVATAR.test(url) ? url : undefined;
};

const time = (v: unknown) => {
  const t = typeof v === 'string' ? Date.parse(v) : Number.NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
};

const positive = (v: unknown) =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;

/** An account as a review shows it; undefined without a login. */
export function toPerson(a: GraphActor | null | undefined): PullRequestPerson | undefined {
  const login = text(a?.login, 100);
  if (!a || !login) return undefined;
  return clean({
    login,
    name: text(a.name, 200),
    avatarUrl: avatar(a.avatarUrl),
    bot: a.__typename === 'Bot' ? true : undefined,
  });
}

/** A description cut to MAX_PR_BODY characters, never mid-character, saying when it was cut. */
export function clipBody(body: unknown, max = MAX_PR_BODY) {
  if (typeof body !== 'string' || !body) return {};
  if (body.length <= max) return { body };
  const end = /[\uD800-\uDBFF]/.test(body.charAt(max - 1)) ? max - 1 : max;
  return { body: body.slice(0, end), bodyTruncated: true };
}

const REVIEW_STATE = new Map<string, PullRequestReview['state']>([
  ['APPROVED', 'approved'],
  ['CHANGES_REQUESTED', 'changes-requested'],
  ['COMMENTED', 'commented'],
  ['DISMISSED', 'dismissed'],
]);

const PR_STATE = new Map<string, PullRequest['state']>([
  ['OPEN', 'open'],
  ['CLOSED', 'closed'],
  ['MERGED', 'merged'],
]);

const nodesOf = <T>(c: { nodes?: (T | null)[] } | null | undefined): T[] =>
  Array.isArray(c?.nodes) ? c.nodes.filter((n): n is T => !!n && typeof n === 'object') : [];

/** The details a review shows: who wrote it and was asked, its description, labels and more. */
function toDetails(node: GraphNode, repo: string): Partial<PullRequest> {
  const reviews = nodesOf(node.reviews).flatMap((r) => {
    const by = toPerson(r.author);
    const state = REVIEW_STATE.get(r.state ?? '');
    return by && state
      ? [clean({ by, state, submittedAt: time(r.submittedAt), url: link(r.url) })]
      : [];
  });
  const asked = nodesOf(node.reviewRequests).map((r) => r.requestedReviewer);
  const teams = asked.flatMap((t) => {
    const slug = t?.__typename === 'Team' ? text(t.slug, 100) : undefined;
    return slug ? [clean({ slug, name: text(t?.name, 200) })] : [];
  });
  const labels = nodesOf(node.labels).flatMap((l) => {
    const name = text(l.name, 100);
    return name && typeof l.color === 'string' && /^[0-9a-fA-F]{6}$/.test(l.color)
      ? [{ name, color: l.color }]
      : [];
  });
  const closes = nodesOf(node.closingIssuesReferences).flatMap((i) => {
    const number = positive(i.number);
    const from = text(i.repository?.nameWithOwner, 200) ?? repo;
    return number
      ? [clean({ repo: from, number, title: text(i.title, 500), url: link(i.url) })]
      : [];
  });
  const m = node.milestone;
  const title = text(m?.title, 300);
  const sha = node.headRefOid;
  return clean({
    state: PR_STATE.get(node.state ?? ''),
    authorProfile: toPerson(node.author),
    ...clipBody(node.body),
    createdAt: time(node.createdAt),
    headSha: typeof sha === 'string' && /^[0-9a-f]{7,64}$/.test(sha) ? sha : undefined,
    mergeable:
      node.mergeable === 'MERGEABLE' ? true : node.mergeable === 'CONFLICTING' ? false : undefined,
    commits:
      typeof node.commits?.totalCount === 'number' ? count(node.commits.totalCount) : undefined,
    reviews: node.reviews ? reviews.slice(-MAX_PR_REVIEWS) : undefined,
    requestedReviewers: node.reviewRequests
      ? asked
          .flatMap((p) => (p?.__typename === 'User' ? (toPerson(p) ?? []) : []))
          .slice(0, MAX_PR_REVIEWERS)
      : undefined,
    requestedTeams: node.reviewRequests ? teams.slice(0, MAX_PR_REVIEWERS) : undefined,
    labels: node.labels ? labels.slice(0, MAX_PR_LABELS) : undefined,
    milestone:
      m && title
        ? clean({ title, number: positive(m.number), url: link(m.url), dueOn: time(m.dueOn) })
        : undefined,
    closes: node.closingIssuesReferences ? closes.slice(0, MAX_PR_CLOSES) : undefined,
  });
}

/** One search result as a PullRequest, or undefined when it isn't a whole pull request. */
export function toPullRequest(node: GraphNode): PullRequest | undefined {
  const repo = node.repository?.nameWithOwner;
  if (!node.number || !node.title || !node.url || !repo || !node.headRefName || !node.updatedAt) {
    return undefined;
  }
  const rollup = node.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  const state = rollup?.state;
  const ci: PullRequest['ci'] = !rollup
    ? 'skipped'
    : state === 'SUCCESS'
      ? 'pass'
      : state === 'FAILURE' || state === 'ERROR'
        ? 'fail'
        : 'pending';
  const counts = [
    ...(rollup?.contexts?.checkRunCountsByState ?? []),
    ...(rollup?.contexts?.statusContextCountsByState ?? []),
  ];
  const passed = counts
    .filter((c) => c.state && PASSED.has(c.state))
    .reduce((n, c) => n + (c.count ?? 0), 0);
  const total = rollup?.contexts?.totalCount ?? 0;
  return {
    number: node.number,
    title: node.title,
    url: node.url,
    repo,
    branch: node.headRefName,
    author: node.author?.login ?? 'ghost',
    updatedAt: new Date(node.updatedAt).toISOString(),
    draft: node.isDraft === true,
    additions: node.additions ?? 0,
    deletions: node.deletions ?? 0,
    review: node.reviewDecision ? REVIEW.get(node.reviewDecision) : undefined,
    ci,
    ciDetail: total ? `${passed}/${total}` : undefined,
    checks: rollup ? toChecks(rollup.contexts?.nodes) : undefined,
    base: node.baseRefName || undefined,
    files: toFiles(node.files?.nodes),
    changedFiles: typeof node.changedFiles === 'number' ? count(node.changedFiles) : undefined,
    ...toDetails(node, repo),
  };
}

const prs = (nodes: unknown): PullRequest[] =>
  Array.isArray(nodes)
    ? nodes.flatMap((n: GraphNode) => {
        const pr = toPullRequest(n);
        return pr ? [pr] : [];
      })
    : [];

/** Reads both lists through `gh`, or says why it couldn't. */
export function readGitHub(at = Date.now()): GitHubReport {
  const run = spawnSync('gh', ['api', 'graphql', '-f', `query=${QUERY}`], {
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const empty = { at, reviewRequested: [], mine: [] };
  if (run.error && 'code' in run.error && run.error.code === 'ENOENT') {
    return { ...empty, status: 'not-installed' };
  }
  if (run.status !== 0) {
    const signedOut = /auth login|not logged in|authentication/i.test(run.stderr ?? '');
    return { ...empty, status: signedOut ? 'signed-out' : 'error' };
  }
  try {
    const body: { data?: { review?: { nodes?: unknown }; mine?: { nodes?: unknown } } } =
      JSON.parse(run.stdout);
    return {
      at,
      status: 'ok',
      reviewRequested: prs(body.data?.review?.nodes),
      mine: prs(body.data?.mine?.nodes),
    };
  } catch {
    return { ...empty, status: 'error' };
  }
}

// Open pull requests for the person signed in to `gh` on this machine: the ones waiting on their
// review and their own, with CI. Read through `gh`, so GitHub credentials never leave the
// machine. One machine-wide read a minute at most, whichever session's sync gets there first.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { GitHubReport, PullRequest, PullRequestFile } from '@joc/protocol';

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

const PR_FIELDS = `
  ... on PullRequest {
    number title url isDraft additions deletions reviewDecision updatedAt headRefName baseRefName
    changedFiles files(first: 100) { nodes { path additions deletions changeType } }
    repository { nameWithOwner }
    author { login }
    commits(last: 1) { nodes { commit { statusCheckRollup { state contexts {
      totalCount
      checkRunCountsByState { state count }
      statusContextCountsByState { state count }
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
/** A commit's combined CI result, as GitHub's GraphQL API reports it. */
export type Rollup = {
  state?: string;
  contexts?: {
    totalCount?: number;
    checkRunCountsByState?: Count[];
    statusContextCountsByState?: Count[];
  };
} | null;

export interface GraphFile {
  path?: string;
  additions?: number;
  deletions?: number;
  changeType?: string;
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
  changedFiles?: number;
  files?: { nodes?: GraphFile[] } | null;
  repository?: { nameWithOwner?: string };
  author?: { login?: string } | null;
  commits?: { nodes?: { commit?: { statusCheckRollup?: Rollup } }[] };
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
    base: node.baseRefName || undefined,
    files: toFiles(node.files?.nodes),
    changedFiles: typeof node.changedFiles === 'number' ? count(node.changedFiles) : undefined,
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

import type {
  CIStatus,
  OperationNeed,
  OperationPull,
  OperationRow,
  Operations,
  SessionState,
} from '@joc/protocol';
import { age, ago } from './time.ts';

// Operations' rows as the page shows them: the words, links and pipeline of each, the groups
// and the filters. The server decides what the rows are and what needs you (#111).

// What OperationRow in @joc/ui takes, named here: this file is tested in Node.

export interface OpLink {
  label: string;
  href?: string;
  external?: boolean;
  onClick?: () => void;
}

export interface OpPiece {
  text: string;
  glyph?: boolean;
  priority: number;
  icon?: 'pr' | 'check' | 'comment';
  ci?: CIStatus;
  dot?: SessionState;
  tone?: 'muted' | 'fail';
}

export interface OperationRowProps {
  deployed?: boolean;
  title: string;
  branch?: string;
  meta: string;
  age: string;
  needs?: string;
  done?: boolean;
  work: OpLink;
  claude?: { state: SessionState; activity?: string; quiet?: boolean; link: OpLink };
  start?: OpLink;
  pr?: {
    number: number;
    state: 'open' | 'draft' | 'closed' | 'merged';
    additions: number;
    deletions: number;
    link: OpLink;
  };
  ci?: { status: CIStatus; detail?: string; note: string; link: OpLink };
  review?: {
    kind: 'approved' | 'changes' | 'required' | 'commented';
    people: { name: string; src?: string }[];
    note: string;
    link: OpLink;
  };
  merged?:
    | { kind: 'merged'; when: string; link: OpLink }
    | { kind: 'conflicts'; note: string; link: OpLink };
  deploy?: { status: CIStatus; environment: string; note: string; link: OpLink };
  /** Said in the Deployed cell when there is no deploy, e.g. "No deploys reported". */
  deployNote?: string;
  pieces: OpPiece[];
  pipeline: OpLink;
}

export const NEED_LABEL: Record<OperationNeed, string> = {
  answer: 'Answer Claude',
  ci: 'Fix CI',
  conflicts: 'Resolve conflicts',
  review: 'Address review',
  deploy: 'Fix deploy',
};

export const OPS_FILTERS = ['all', 'needs', 'review', 'shipped'] as const;
export type OpsFilter = (typeof OPS_FILTERS)[number];
export const isOpsFilter = (id: string): id is OpsFilter => OPS_FILTERS.some((f) => f === id);

const PR_WORD = { open: 'Open', draft: 'Draft', closed: 'Closed', merged: 'Merged' } as const;
const CI_WORD = { pass: 'passed', fail: 'failed', pending: 'pending', skipped: 'skipped' } as const;
const REVIEW_WORD = {
  approved: 'Approved',
  changes: 'Changes requested',
  required: 'Review required',
  commented: 'Commented',
} as const;

const conversation = (id: string, tab?: string) =>
  `/?${new URLSearchParams({ session: id, ...(tab ? { tab } : {}) })}`;

const github = (href: string, label: string): OpLink => ({ href, label, external: true });

/** The repo's page on the same GitHub as the pull request. */
const repoUrl = (pull: OperationPull, repo: string) => `${new URL(pull.url).origin}/${repo}`;

/** Whether its pull request is in review: open, not a draft, not merged. */
export const inReview = (row: OperationRow) => row.pull?.state === 'open';

/** The CI cell: its badge's detail and the line under it. */
export function ciText(pull: OperationPull): { detail?: string; note: string } {
  const { total, done, failing } = pull.checks;
  const checks = (n: number) => `${n} ${n === 1 ? 'check' : 'checks'}`;
  switch (pull.ci) {
    case 'fail':
      return {
        detail: failing.length ? String(failing.length) : undefined,
        note: failing.join(', ') || 'Checks failed',
      };
    case 'pending':
      return total
        ? { detail: `${done}/${total}`, note: `${checks(total - done)} running` }
        : { note: 'Checks running' };
    case 'pass':
      return { note: total ? checks(total) : 'Checks passed' };
    case 'skipped':
      return { note: pull.state === 'draft' ? 'Draft, checks not run' : 'No checks' };
  }
}

/** The Review cell's line: who reviewed, or "2 approvals". */
export function reviewNote(pull: OperationPull): string {
  const names = pull.reviewers.map((p) => p.name ?? p.login);
  if (pull.review === 'approved' && names.length > 1) return `${names.length} approvals`;
  if (names.length > 1) return `${names[0]} +${names.length - 1}`;
  return names[0] ?? (pull.review === 'required' ? 'Waiting for a reviewer' : '');
}

export interface RowContext {
  now: number;
  /** The Deployed column is on screen. */
  deployed: boolean;
  /** Shown in the Shipped group, where the repo's short name joins the meta. */
  shippedGroup?: boolean;
  /** Its repo reports deploys. */
  repoDeploys?: boolean;
  /** Starts a session on a pull request's branch. */
  onStart?: (row: OperationRow) => void;
}

/** One row's props for OperationRow, but for its layout. */
export function rowProps(row: OperationRow, ctx: RowContext): OperationRowProps {
  const { now, deployed } = ctx;
  const { session, pull } = row;
  const when = age(row.activeAt, now);
  const meta = [
    ...(ctx.shippedGroup ? [row.repo.split('/')[1] ?? row.repo] : []),
    ...(pull && !session && !pull.mine ? [`by ${pull.author}`] : []),
    when,
  ].join(' · ');
  const needs = row.needs[0] ? NEED_LABEL[row.needs[0]] : undefined;

  const work: OpLink = session
    ? { href: conversation(session.id), label: `Open conversation: ${row.title}` }
    : pull
      ? github(pull.url, `Open pull request #${pull.number} on GitHub`)
      : { label: row.title };

  const props: OperationRowProps = {
    deployed,
    title: row.title,
    branch: row.branch,
    meta,
    age: when,
    needs,
    done: !!row.shippedAt,
    work,
    pieces: [],
    pipeline: pull ? github(pull.url, `Open pull request #${pull.number} on GitHub`) : work,
  };

  if (session) {
    props.claude = {
      state: session.state,
      activity: session.activity,
      quiet: session.quiet,
      link: {
        href: conversation(session.id),
        label:
          session.state === 'needs' ? `Answer Claude in ${row.title}` : 'Open the latest message',
      },
    };
  } else if (pull && ctx.onStart && pull.state !== 'merged' && pull.state !== 'closed') {
    const start = ctx.onStart;
    props.start = {
      label: "Start a session on this pull request's branch",
      onClick: () => start(row),
    };
  }

  const pieces: OpPiece[] = [];
  if (pull) {
    const muted = pull.state === 'draft' || pull.state === 'closed';
    props.pr = {
      number: pull.number,
      state: pull.state,
      additions: pull.additions,
      deletions: pull.deletions,
      link: session
        ? { href: conversation(session.id, 'changes'), label: `Open Changes for #${pull.number}` }
        : github(`${pull.url}/files`, `Open files changed in #${pull.number} on GitHub`),
    };
    pieces.push({
      icon: 'pr',
      text: `#${pull.number} ${PR_WORD[pull.state]}`,
      glyph: true,
      tone: muted ? 'muted' : undefined,
      priority: 3,
    });

    const ci = ciText(pull);
    const firstFailing = pull.checks.failing[0];
    props.ci = {
      status: pull.ci,
      detail: ci.detail,
      note: ci.note,
      link: github(
        `${pull.url}/checks`,
        pull.ci === 'fail' && firstFailing
          ? `Open the ${firstFailing} check`
          : `Open checks for #${pull.number}`,
      ),
    };
    pieces.push({
      ci: pull.ci,
      text: `CI ${CI_WORD[pull.ci]}${ci.detail ? ` ${ci.detail}` : ''}`,
      glyph: true,
      tone: pull.ci === 'fail' ? 'fail' : undefined,
      priority: pull.ci === 'fail' ? 0 : 2,
    });

    if (pull.review) {
      props.review = {
        kind: pull.review,
        people: pull.reviewers.map((p) => ({ name: p.name ?? p.login, src: p.avatarUrl })),
        note: reviewNote(pull),
        link: github(pull.reviewUrl ?? pull.url, 'Open the latest review on GitHub'),
      };
      pieces.push({
        icon: pull.review === 'approved' ? 'check' : 'comment',
        text: REVIEW_WORD[pull.review],
        glyph: true,
        priority: pull.review === 'changes' ? 0 : 2,
      });
    }

    if (pull.state === 'merged') {
      const mergedAt = pull.mergedAt ?? pull.closedAt;
      props.merged = {
        kind: 'merged',
        when: mergedAt ? ago(mergedAt, now) : '',
        link: github(
          pull.mergeCommit ? `${repoUrl(pull, row.repo)}/commit/${pull.mergeCommit}` : pull.url,
          'Open the merge commit on GitHub',
        ),
      };
      pieces.push({
        icon: 'check',
        text: mergedAt ? `Merged ${ago(mergedAt, now)}` : 'Merged',
        glyph: true,
        priority: 2,
      });
    } else if (pull.conflicts) {
      props.merged = {
        kind: 'conflicts',
        note: `With ${pull.base ?? 'its base'}, rebase needed`,
        link: github(pull.url, `Open the conflicts in #${pull.number} on GitHub`),
      };
      pieces.push({ dot: 'needs', text: 'Conflicts', glyph: true, priority: 0 });
    }

    const d = pull.deploy;
    if (deployed && d && pull.state === 'merged') {
      props.deploy = {
        status: d.status,
        environment: d.environment,
        note:
          d.status === 'pass'
            ? ago(d.at, now)
            : d.status === 'fail'
              ? `${d.environment} · ${pull.mine ? 'your merge' : 'not your merge'}`
              : `${d.environment} · ${age(d.at, now)}`,
        link: github(
          d.url ?? `${repoUrl(pull, row.repo)}/deployments`,
          d.status === 'fail' ? 'Open the failed deploy on GitHub' : 'Open the deploy on GitHub',
        ),
      };
      pieces.push(
        d.status === 'pass'
          ? { icon: 'check', text: `Deployed ${ago(d.at, now)}`, glyph: true, priority: 2 }
          : d.status === 'fail'
            ? { ci: 'fail', text: 'Deploy failed', glyph: true, tone: 'fail', priority: 0 }
            : { ci: 'pending', text: 'Deploying', glyph: true, priority: 2 },
      );
    }
    if (deployed && !d && ctx.shippedGroup && !ctx.repoDeploys) {
      props.deployNote = 'No deploys reported';
    }
  } else if (session) {
    pieces.push({ text: 'No pull request yet', tone: 'muted', priority: 0 });
  }
  // The furthest stage reached outranks the ones before it.
  const last = pieces.at(-1);
  if (last?.priority === 2) last.priority = 1;
  props.pieces = pieces;
  return props;
}

/** Whether the row matches what's typed: its title, branch or #number. */
export function matchesOps(row: OperationRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const number = row.pull ? `#${row.pull.number}` : '';
  return [row.title, row.branch, number, row.pull ? String(row.pull.number) : undefined].some((f) =>
    f?.toLowerCase().includes(q),
  );
}

const midnight = (now: number) => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

export const shippedToday = (row: OperationRow, now: number) =>
  !!row.shippedAt && Date.parse(row.shippedAt) >= midnight(now);

export interface OpsGroup {
  repo: string;
  /** Every in-flight row of the repo, whatever the filter: the header counts these. */
  all: OperationRow[];
  /** The rows the filter shows. */
  rows: OperationRow[];
  needs: number;
  /** The repo reports deploys. */
  deploys: boolean;
}

export interface OpsView {
  groups: OpsGroup[];
  /** Shipped rows the filter shows, and how many there are in all. */
  shipped: OperationRow[];
  shippedCount: number;
  counts: Record<OpsFilter, number>;
  /** Some repo on screen reports deploys: the Deployed column shows. */
  deployed: boolean;
}

/**
 * The groups as shown: in-flight rows by repo, A to Z, each in `order` (the order rows first
 * arrived in, so new ones join the end), and the shipped ones apart. `folded` names the rows
 * shown as shipped: a row that just shipped stays in its group until the pointer leaves.
 */
export function opsView(
  ops: Operations,
  {
    filter,
    query,
    now,
    order,
    folded,
  }: {
    filter: OpsFilter;
    query: string;
    now: number;
    order: Map<string, number>;
    folded: ReadonlySet<string>;
  },
): OpsView {
  const place = (r: OperationRow) => order.get(r.id) ?? Number.POSITIVE_INFINITY;
  const rows = [...ops.rows].sort((a, b) => place(a) - place(b));
  const deployRepos = new Set(ops.deployRepos.map((r) => r.toLowerCase()));
  const flying = rows.filter((r) => !folded.has(r.id));
  const shippedAll = rows.filter((r) => folded.has(r.id));
  const typed = (r: OperationRow) => matchesOps(r, query);
  const pick = (r: OperationRow) =>
    typed(r) &&
    (filter === 'all' ||
      (filter === 'needs' ? r.needs.length > 0 : filter === 'review' && inReview(r)));

  const byRepo = new Map<string, OperationRow[]>();
  for (const r of flying) byRepo.set(r.repo, [...(byRepo.get(r.repo) ?? []), r]);
  const groups = [...byRepo]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([repo, all]) => ({
      repo,
      all,
      rows: filter === 'shipped' ? [] : all.filter(pick),
      needs: all.filter((r) => r.needs.length).length,
      deploys: deployRepos.has(repo.toLowerCase()),
    }));
  const shipped =
    filter === 'shipped'
      ? shippedAll.filter((r) => typed(r) && shippedToday(r, now))
      : filter === 'all'
        ? shippedAll.filter(typed)
        : [];
  const visibleRepos = [
    ...groups.filter((g) => g.rows.length).map((g) => g.repo),
    ...shipped.map((r) => r.repo),
  ];
  return {
    groups,
    shipped,
    shippedCount: shippedAll.length,
    counts: {
      all: flying.length,
      needs: flying.filter((r) => r.needs.length).length,
      review: flying.filter(inReview).length,
      shipped: shippedAll.filter((r) => shippedToday(r, now)).length,
    },
    deployed: visibleRepos.some((r) => deployRepos.has(r.toLowerCase())),
  };
}

/** How many rows need you, for the nav. */
export const opsNeeds = (ops: Operations | undefined) =>
  ops?.rows.filter((r) => r.needs.length).length ?? 0;

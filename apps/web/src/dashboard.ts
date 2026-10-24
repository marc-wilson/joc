import type {
  ActivityEvent,
  OperationMachine,
  OperationNeed,
  OperationRow,
  Operations,
  SessionState,
} from '@joc/protocol';
import { age, ago } from './time.ts';

// The Operations dashboard (#114) from Operations' rows: the totals, the pipeline, the queue of
// what needs you, repos, machines and a week's throughput. The table is its drill-down, and every
// number here counts exactly the rows its drill-down shows. Tested in Node.

export type Stage = 'session' | 'pr' | 'review' | 'merged' | 'deployed';
export const STAGES: { id: Stage; label: string; short: string }[] = [
  { id: 'session', label: 'Sessions', short: 'Session' },
  { id: 'pr', label: 'Pull request', short: 'PR' },
  { id: 'review', label: 'Review', short: 'Review' },
  { id: 'merged', label: 'Merged', short: 'Merged' },
  { id: 'deployed', label: 'Deployed', short: 'Deployed' },
];

export type Kpi = 'needs' | 'working' | 'background' | 'prs' | 'cifail' | 'review' | 'shipped';
export const KPIS: { id: Kpi; label: string; github: boolean }[] = [
  { id: 'needs', label: 'Needs you', github: false },
  { id: 'working', label: 'Working', github: false },
  { id: 'background', label: 'In background', github: false },
  { id: 'prs', label: 'Open PRs', github: true },
  { id: 'cifail', label: 'CI failing', github: true },
  { id: 'review', label: 'In review', github: true },
  { id: 'shipped', label: 'Shipped today', github: true },
];

/** What the table is filtered to; none is the overview. */
export type Drill =
  | { kind: 'kpi'; id: Kpi }
  | { kind: 'stage'; id: Stage }
  | { kind: 'repo'; id: string }
  | { kind: 'machine'; id: string }
  | { kind: 'all' };

const isKpi = (v: string): v is Kpi => KPIS.some((k) => k.id === v);
const isStage = (v: string): v is Stage => STAGES.some((s) => s.id === v);

/** The drill-down a URL's query names: `?show=needs`, `?stage=review`, `?repo=`, `?machine=`. */
export function parseDrill(search: string): Drill | undefined {
  const q = new URLSearchParams(search);
  const show = q.get('show');
  const stage = q.get('stage');
  const repo = q.get('repo');
  const machine = q.get('machine');
  if (show === 'all') return { kind: 'all' };
  if (show && isKpi(show)) return { kind: 'kpi', id: show };
  if (stage && isStage(stage)) return { kind: 'stage', id: stage };
  if (repo) return { kind: 'repo', id: repo };
  if (machine) return { kind: 'machine', id: machine };
  return undefined;
}

/** The query that names a drill-down; empty for the overview. */
export function drillSearch(drill: Drill | undefined): string {
  if (!drill) return '';
  const q =
    drill.kind === 'all'
      ? { show: 'all' }
      : drill.kind === 'kpi'
        ? { show: drill.id }
        : { [drill.kind]: drill.id };
  return `?${new URLSearchParams(q)}`;
}

export const sameDrill = (a: Drill | undefined, b: Drill | undefined) =>
  drillSearch(a) === drillSearch(b);

const midnight = (now: number, daysBack = 0) => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysBack);
  return d.getTime();
};

const today = (iso: string | undefined, now: number) => !!iso && Date.parse(iso) >= midnight(now);

/** Where a row stands: the furthest stage it reached. Undefined for a closed pull request alone. */
export function stageOf(row: OperationRow): Stage | undefined {
  const pull = row.pull;
  if (pull?.state === 'merged') return pull.deploy?.status === 'pass' ? 'deployed' : 'merged';
  if (pull?.state === 'open') return 'review';
  if (pull?.state === 'draft') return 'pr';
  return row.session ? 'session' : undefined;
}

/**
 * The work the dashboard counts: everything in flight, and what shipped today. A row that
 * shipped before midnight, or a closed pull request no session works on, is done.
 */
export const counted = (row: OperationRow, now: number) =>
  stageOf(row) !== undefined && (!row.shippedAt || today(row.shippedAt, now));

const live = (row: OperationRow) => row.pull?.state === 'open' || row.pull?.state === 'draft';

/** A failing check on a live pull request, or a failed deploy. */
export const failing = (row: OperationRow) =>
  (live(row) && row.pull?.ci === 'fail') ||
  (row.pull?.state === 'merged' && row.pull.deploy?.status === 'fail');

const inFlight = (row: OperationRow) => !row.shippedAt;

/** Whether a counted row is one a total counts. */
export function kpiMatch(id: Kpi, row: OperationRow, now: number): boolean {
  switch (id) {
    case 'needs':
      return row.needs.length > 0;
    case 'working':
    case 'background':
      return inFlight(row) && row.session?.state === id;
    case 'prs':
      return live(row);
    case 'cifail':
      return live(row) && row.pull?.ci === 'fail';
    case 'review':
      return stageOf(row) === 'review';
    case 'shipped':
      return today(row.shippedAt, now);
  }
}

/** Whether a counted row is in the drill-down. */
export function drillMatch(drill: Drill, row: OperationRow, now: number): boolean {
  switch (drill.kind) {
    case 'all':
      return true;
    case 'kpi':
      return kpiMatch(drill.id, row, now);
    case 'stage':
      return stageOf(row) === drill.id;
    case 'repo':
      return row.repo.toLowerCase() === drill.id.toLowerCase();
    case 'machine':
      return row.session?.machine === drill.id;
  }
}

/** The drill-down's name on its chip. */
export function drillLabel(drill: Drill, machines: OperationMachine[]): string {
  switch (drill.kind) {
    case 'all':
      return 'Everything in flight and shipped today';
    case 'kpi':
      return KPIS.find((k) => k.id === drill.id)?.label ?? drill.id;
    case 'stage':
      return `Stage: ${STAGES.find((s) => s.id === drill.id)?.label ?? drill.id}`;
    case 'repo':
      return drill.id;
    case 'machine':
      return `Machine: ${machines.find((m) => m.id === drill.id)?.name ?? drill.id}`;
  }
}

/** "41m", "1h 5m", "2d 4h": how long, to the minute. */
export function span(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ── Needs you now ──────────────────────────────────────────────────────────

/** The queue's order of urgency, and how each reason is named and acted on. */
const NEED_RANK: OperationNeed[] = ['deploy', 'answer', 'ci', 'conflicts', 'review'];
export const NEED_REASON: Record<OperationNeed, string> = {
  deploy: 'Deploy failed',
  answer: 'Answer Claude',
  ci: 'Fix CI',
  conflicts: 'Resolve conflicts',
  review: 'Address review',
};
const NEED_ACTION: Record<OperationNeed, string> = {
  deploy: 'Open deploy run',
  answer: 'Answer Claude',
  ci: 'Open failing check',
  conflicts: 'Open conflicts',
  review: 'Open review',
};

export interface QueueItem {
  /** The row and its reason: a new reason is a new item. */
  key: string;
  row: OperationRow;
  need: OperationNeed;
  reason: string;
  action: string;
  /** Where the one click goes. */
  href: string;
  external: boolean;
  /** How long it has waited, in ms. */
  waited: number;
}

const conversation = (id: string, tab?: string) =>
  `/?${new URLSearchParams({ session: id, ...(tab ? { tab } : {}) })}`;

/** Where acting on a row's need takes you: the exact place to act. */
function actOn(row: OperationRow, need: OperationNeed): { href: string; external: boolean } {
  const { session, pull } = row;
  const repoUrl = pull ? `${new URL(pull.url).origin}/${row.repo}` : '';
  switch (need) {
    case 'answer':
      return { href: session ? conversation(session.id) : '/', external: false };
    case 'deploy':
      return { href: pull?.deploy?.url ?? `${repoUrl}/deployments`, external: true };
    case 'ci':
      return { href: `${pull?.url}/checks`, external: true };
    case 'conflicts':
      return session
        ? { href: conversation(session.id, 'changes'), external: false }
        : { href: `${pull?.url}/conflicts`, external: true };
    case 'review':
      return { href: pull?.reviewUrl ?? `${pull?.url}`, external: true };
  }
}

/** What needs you, most urgent first: by reason, then the longest waiting. */
export function queueOf(rows: OperationRow[], now: number): QueueItem[] {
  const items = rows.flatMap((row) => {
    const need = NEED_RANK.find((n) => row.needs.includes(n));
    if (!need) return [];
    const since = row.needsSince ?? row.activeAt;
    return [
      {
        key: `${row.id}\n${need}`,
        row,
        need,
        reason: NEED_REASON[need],
        action: NEED_ACTION[need],
        ...actOn(row, need),
        waited: Math.max(0, now - Date.parse(since)),
      },
    ];
  });
  return items.sort(
    (a, b) =>
      NEED_RANK.indexOf(a.need) - NEED_RANK.indexOf(b.need) ||
      b.waited - a.waited ||
      (a.key < b.key ? -1 : 1),
  );
}

/**
 * The queue as shown, calmly: items already on screen keep their order, a new one joins where
 * it ranks among them, and a resolved one goes.
 */
export function settleQueue(shown: string[], ranked: string[]): string[] {
  const kept = shown.filter((k) => ranked.includes(k));
  const out = [...kept];
  for (const key of ranked) {
    if (out.includes(key)) continue;
    // Before the first kept item that ranks after it.
    const at = out.findIndex((k) => kept.includes(k) && ranked.indexOf(k) > ranked.indexOf(key));
    if (at < 0) out.push(key);
    else out.splice(at, 0, key);
  }
  return out;
}

// ── The overview ───────────────────────────────────────────────────────────

export interface KpiView {
  id: Kpi;
  label: string;
  /** Undefined while GitHub isn't connected. */
  value?: number;
  sub: string;
}

export interface StageView {
  id: Stage;
  label: string;
  count: number;
  needs: number;
  failing: number;
  off: boolean;
}

export interface RepoView {
  repo: string;
  inflight: number;
  needs: number;
  segments: { stage: Stage; label: string; short: string; count: number }[];
  note?: string;
}

export interface MachineView {
  machine: OperationMachine;
  status: string;
  live: number;
  states: { state: SessionState; count: number }[];
  sessions: number;
}

export interface DayView {
  label: string;
  merges: number;
  deploys: number;
  today?: boolean;
}

export interface ThroughputView {
  merges: number;
  deploys: number;
  /** Undefined when no merge in the week had a session. */
  medianMs?: number;
  days: DayView[];
}

export interface DashboardView {
  /** GitHub has reported: its tiles and stages count. */
  github: boolean;
  /** The rows counted: in flight, and shipped today. */
  rows: OperationRow[];
  kpis: KpiView[];
  stages: StageView[];
  stuck: number;
  queue: QueueItem[];
  repos: RepoView[];
  machines: MachineView[];
  online: number;
  sessions: number;
  throughput: ThroughputView;
}

const STATE_ORDER: SessionState[] = ['needs', 'working', 'background', 'idle', 'offline'];

/** Seven days of merges and deploys, today last, and the median from a session's start. */
export function throughputOf(ops: Operations, now: number): ThroughputView {
  const from = midnight(now, 6);
  const dayOf = (iso: string) => {
    const t = Date.parse(iso);
    if (t < from || t > now) return -1;
    for (let i = 6; i >= 0; i--) if (t >= midnight(now, 6 - i)) return i;
    return -1;
  };
  const days: DayView[] = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(midnight(now, 6 - i));
    return {
      label: i === 6 ? 'Today' : d.toLocaleDateString('en-US', { weekday: 'short' }),
      merges: 0,
      deploys: 0,
      ...(i === 6 ? { today: true } : {}),
    };
  });
  const leads: number[] = [];
  for (const m of ops.merges) {
    const i = dayOf(m.mergedAt);
    const day = days[i];
    if (day) {
      day.merges++;
      if (m.sessionStartedAt) leads.push(Date.parse(m.mergedAt) - Date.parse(m.sessionStartedAt));
    }
    const deployed = m.deployedAt ? days[dayOf(m.deployedAt)] : undefined;
    if (deployed) deployed.deploys++;
  }
  leads.sort((a, b) => a - b);
  const mid = Math.floor(leads.length / 2);
  const medianMs = leads.length
    ? leads.length % 2
      ? leads[mid]
      : Math.round(((leads[mid - 1] ?? 0) + (leads[mid] ?? 0)) / 2)
    : undefined;
  return {
    merges: days.reduce((n, d) => n + d.merges, 0),
    deploys: days.reduce((n, d) => n + d.deploys, 0),
    ...(medianMs === undefined ? {} : { medianMs }),
    days,
  };
}

const machinesOn = (rows: OperationRow[]) =>
  new Set(rows.flatMap((r) => (r.session?.machine ? [r.session.machine] : []))).size;

export function dashboardOf(ops: Operations, now: number): DashboardView {
  const github = ops.github.state === 'reported';
  const rows = ops.rows.filter((r) => counted(r, now));
  const count = (id: Kpi) => rows.filter((r) => kpiMatch(id, r, now));
  const onMachines = (xs: OperationRow[], none: string) => {
    if (!xs.length) return none;
    const m = machinesOn(xs);
    return m ? `On ${plural(m, 'machine')}` : plural(xs.length, 'session');
  };

  const needs = count('needs');
  const oldest = Math.max(0, ...needs.map((r) => now - Date.parse(r.needsSince ?? r.activeAt)));
  const cifail = count('cifail');
  const subs: Record<Kpi, string> = {
    needs: needs.length ? `Oldest waiting ${span(oldest)}` : 'Nothing waiting',
    working: onMachines(count('working'), 'No session working'),
    background: onMachines(count('background'), 'Nothing in background'),
    prs: plural(rows.filter((r) => r.pull?.state === 'draft').length, 'draft'),
    cifail: cifail.length
      ? cifail.map((r) => `#${r.pull?.number}`).join(' · ')
      : 'No failing checks',
    review: `${count('review').filter((r) => r.pull?.review === 'approved').length} approved`,
    shipped: `${count('shipped').filter((r) => r.pull?.deploy?.status === 'pass').length} deployed`,
  };
  const kpis = KPIS.map((k) => {
    const off = k.github && !github;
    return {
      id: k.id,
      label: k.label,
      ...(off ? {} : { value: count(k.id).length }),
      sub: off ? 'Needs GitHub' : subs[k.id],
    };
  });

  const stages = STAGES.map((s) => {
    const xs = rows.filter((r) => stageOf(r) === s.id);
    return {
      id: s.id,
      label: s.label,
      count: xs.length,
      needs: xs.filter((r) => r.needs.length).length,
      failing: xs.filter(failing).length,
      off: !github && s.id !== 'session',
    };
  });

  const deployRepos = new Set(ops.deployRepos.map((r) => r.toLowerCase()));
  const byRepo = new Map<string, OperationRow[]>();
  for (const r of rows) byRepo.set(r.repo, [...(byRepo.get(r.repo) ?? []), r]);
  const repos = [...byRepo]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([repo, xs]) => ({
      repo,
      inflight: xs.filter(inFlight).length,
      needs: xs.filter((r) => r.needs.length).length,
      segments: STAGES.map((s) => ({
        stage: s.id,
        label: s.label,
        short: s.short,
        count: xs.filter((r) => stageOf(r) === s.id).length,
      })).filter((s) => s.count > 0),
      ...(!github
        ? { note: 'From each session’s git remote' }
        : deployRepos.size && !deployRepos.has(repo.toLowerCase()) && xs.some((r) => r.pull)
          ? { note: 'No deploys reported, so merges stop at Merged' }
          : {}),
    }));

  const machines = ops.machines.map((machine) => {
    const xs = rows.filter((r) => r.session?.machine === machine.id);
    return {
      machine,
      status: machine.online
        ? 'Online'
        : machine.lastSeenAt
          ? `Last seen ${ago(machine.lastSeenAt, now)}`
          : 'Offline',
      live: xs.filter((r) => r.session?.state !== 'offline').length,
      states: STATE_ORDER.map((state) => ({
        state,
        count: xs.filter((r) => r.session?.state === state).length,
      })).filter((s) => s.count > 0),
      sessions: xs.length,
    };
  });

  return {
    github,
    rows,
    kpis,
    stages,
    stuck: rows.filter((r) => r.needs.length || failing(r)).length,
    queue: queueOf(rows, now),
    repos,
    machines,
    online: ops.machines.filter((m) => m.online).length,
    sessions: rows.filter((r) => r.session).length,
    throughput: throughputOf(ops, now),
  };
}

// ── Live activity ──────────────────────────────────────────────────────────

export type EventGlyph =
  | { dot: SessionState }
  | { ci: 'pass' | 'fail' | 'pending' | 'skipped' }
  | { icon: 'pr' | 'comment' | 'branch' };

export interface EventView {
  id: string;
  time: string;
  glyph: EventGlyph;
  what: string;
  subject: string;
  where: string;
}

const REVIEW_WORDS = {
  approved: 'approved',
  changes: 'requested changes on',
  commented: 'commented on',
} as const;

/** One event as the feed says it: when, its glyph, and what happened to what, where. */
export function eventView(e: ActivityEvent, now: number): EventView {
  const where = e.repo.split('/')[1] ?? e.repo;
  const ref = e.number ? `#${e.number}` : '';
  const base = { id: e.id, time: age(e.at, now), where };
  switch (e.kind) {
    case 'started':
      return { ...base, glyph: { dot: 'working' }, what: 'Claude started', subject: e.title };
    case 'asked':
      return { ...base, glyph: { dot: 'needs' }, what: 'Claude asked you in', subject: e.title };
    case 'finished':
      return { ...base, glyph: { dot: 'idle' }, what: 'Claude finished in', subject: e.title };
    case 'background':
      return {
        ...base,
        glyph: { dot: 'background' },
        what: 'Claude went to the background in',
        subject: e.title,
      };
    case 'opened':
      return { ...base, glyph: { icon: 'pr' }, what: 'Opened', subject: `${ref} ${e.title}` };
    case 'ci':
      return {
        ...base,
        glyph: { ci: e.status ?? 'pending' },
        what: e.status === 'fail' ? 'CI failed on' : 'CI passed on',
        subject: `${ref} ${e.detail ?? e.title}`,
      };
    case 'review':
      return {
        ...base,
        glyph: { icon: 'comment' },
        what: `${e.by ?? 'A reviewer'} ${REVIEW_WORDS[e.review ?? 'commented']}`,
        subject: ref || e.title,
      };
    case 'merged':
      return { ...base, glyph: { icon: 'branch' }, what: 'Merged', subject: `${ref} ${e.title}` };
    case 'deploy':
      return e.status === 'fail'
        ? {
            ...base,
            glyph: { ci: 'fail' },
            what: 'Deploy failed on',
            subject: `${ref} ${e.detail ?? ''}`.trim(),
          }
        : {
            ...base,
            glyph: { ci: 'pass' },
            what: 'Deployed',
            subject: e.detail ? `${ref} to ${e.detail}` : ref,
          };
  }
}

/** The feed's events, newest first, without repeats, at most `limit`. */
export function mergeEvents(
  kept: ActivityEvent[],
  arrived: ActivityEvent[],
  limit = 50,
): ActivityEvent[] {
  const byId = new Map<string, ActivityEvent>();
  for (const e of [...arrived, ...kept]) if (!byId.has(e.id)) byId.set(e.id, e);
  return [...byId.values()]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, limit);
}

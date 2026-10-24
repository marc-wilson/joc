// The Operations dashboard's numbers, queue, throughput and feed, from made-up harbor-labs work.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActivityEvent, OperationPull, OperationRow, Operations } from '@joc/protocol';
import {
  type Drill,
  dashboardOf,
  drillLabel,
  drillMatch,
  drillSearch,
  eventView,
  KPIS,
  kpiMatch,
  mergeEvents,
  parseDrill,
  queueOf,
  settleQueue,
  span,
  stageOf,
  throughputOf,
} from './dashboard.ts';

process.env.TZ = 'UTC';

const now = Date.parse('2026-10-21T12:00:00.000Z');
const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

const ATLAS = 'harbor-labs/atlas-web';
const BILL = 'harbor-labs/billing-api';
const MKT = 'harbor-labs/marketing-site';

const pull = (number: number, extra: Partial<OperationPull> = {}): OperationPull => ({
  number,
  url: `https://github.com/${ATLAS}/pull/${number}`,
  state: 'open',
  author: 'rowan',
  mine: true,
  additions: 10,
  deletions: 2,
  ci: 'pass',
  checks: { total: 7, done: 7, failing: [] },
  reviewers: [],
  conflicts: false,
  ...extra,
});

const row = (id: string, extra: Partial<OperationRow> = {}): OperationRow => ({
  id,
  repo: ATLAS,
  title: `Work ${id}`,
  branch: `feat/${id}`,
  since: at(120),
  activeAt: at(10),
  needs: [],
  ...extra,
});

const deploy = (status: 'pass' | 'fail' | 'pending', minutes: number) => ({
  environment: 'production',
  status,
  at: at(minutes),
  url: 'https://github.com/harbor-labs/marketing-site/actions/runs/1',
});

/** The approved board's work, near enough: every stage, every reason to need you. */
const ROWS: OperationRow[] = [
  row('auth', {
    session: { id: 'auth', state: 'needs', machine: 'mbp' },
    pull: pull(482),
    needs: ['answer'],
    needsSince: at(2),
  }),
  row('checkout', {
    session: { id: 'checkout', state: 'idle', machine: 'mbp' },
    pull: pull(479, { ci: 'fail', checks: { total: 7, done: 7, failing: ['lint'] } }),
    needs: ['ci'],
    needsSince: at(14),
  }),
  row('dark', { session: { id: 'dark', state: 'working', machine: 'mbp' } }),
  row('next', { pull: pull(476, { mine: false, review: 'approved' }) }),
  row('cdn', { session: { id: 'cdn', state: 'background', machine: 'mbp' }, pull: pull(481) }),
  row('search', {
    session: { id: 'search', state: 'offline', machine: 'box' },
    pull: pull(470, { state: 'draft', ci: 'skipped' }),
  }),
  row('prorate', {
    repo: BILL,
    session: { id: 'prorate', state: 'idle', machine: 'studio' },
    pull: pull(215, { review: 'changes', reviewUrl: 'https://github.com/x/pull/215#r1' }),
    needs: ['review'],
    needsSince: at(22),
  }),
  row('tax', {
    repo: BILL,
    session: { id: 'tax', state: 'idle', machine: 'studio' },
    pull: pull(210, { conflicts: true }),
    needs: ['conflicts'],
    needsSince: at(41),
  }),
  row('webhook', {
    repo: BILL,
    session: { id: 'webhook', state: 'working', machine: 'studio' },
    pull: pull(218, { state: 'draft', ci: 'fail', mine: false }),
  }),
  row('pricing', {
    repo: MKT,
    session: { id: 'pricing', state: 'idle', machine: 'studio' },
    pull: pull(97, { state: 'merged', mergedAt: at(60), deploy: deploy('fail', 9) }),
    needs: ['deploy', 'answer'],
    needsSince: at(9),
  }),
  // Shipped today, and yesterday (done: not counted).
  row('changelog', {
    repo: MKT,
    pull: pull(95, { state: 'merged', mergedAt: at(300), deploy: deploy('pass', 240) }),
    shippedAt: at(240),
  }),
  row('invoice', {
    repo: BILL,
    pull: pull(212, { state: 'merged', mergedAt: at(180) }),
    shippedAt: at(180),
  }),
  row('old', {
    pull: pull(400, { state: 'merged', mergedAt: at(1300), deploy: deploy('pass', 1290) }),
    shippedAt: at(1290),
  }),
  row('closed', { pull: pull(401, { state: 'closed' }) }),
];

const OPS: Operations = {
  rows: ROWS,
  machines: [
    { id: 'mbp', name: 'rowan-mbp', online: true, lastSeenAt: at(0) },
    { id: 'studio', name: 'rowan-studio', online: true, lastSeenAt: at(1) },
    { id: 'box', name: 'build-box', online: false, lastSeenAt: at(180) },
  ],
  merges: [],
  deployRepos: [ATLAS, MKT],
  github: { state: 'reported', status: 'ok', updatedAt: at(1) },
};

test('each row sits at the furthest stage it reached', () => {
  assert.deepEqual(
    ROWS.map((r) => [r.id, stageOf(r)]),
    [
      ['auth', 'review'],
      ['checkout', 'review'],
      ['dark', 'session'],
      ['next', 'review'],
      ['cdn', 'review'],
      ['search', 'pr'],
      ['prorate', 'review'],
      ['tax', 'review'],
      ['webhook', 'pr'],
      ['pricing', 'merged'],
      ['changelog', 'deployed'],
      ['invoice', 'merged'],
      ['old', 'deployed'],
      ['closed', undefined],
    ],
  );
});

test('the totals count in-flight work and what shipped today, and say what is behind them', () => {
  const view = dashboardOf(OPS, now);
  // Yesterday's ship and a closed pull request alone are done.
  assert.equal(view.rows.length, 12);
  assert.deepEqual(
    view.kpis.map((k) => [k.label, k.value, k.sub]),
    [
      ['Needs you', 5, 'Oldest waiting 41m'],
      ['Working', 2, 'On 2 machines'],
      ['In background', 1, 'On 1 machine'],
      ['Open PRs', 8, '2 drafts'],
      ['CI failing', 2, '#479 · #218'],
      ['In review', 6, '1 approved'],
      ['Shipped today', 2, '1 deployed'],
    ],
  );
  assert.deepEqual(
    view.stages.map((s) => [s.label, s.count, s.needs, s.failing]),
    [
      ['Sessions', 1, 0, 0],
      ['Pull request', 2, 0, 1],
      ['Review', 6, 4, 1],
      ['Merged', 2, 1, 1],
      ['Deployed', 1, 0, 0],
    ],
  );
  assert.equal(view.stuck, 6);
});

test('every total and stage opens exactly the rows it counts', () => {
  const view = dashboardOf(OPS, now);
  for (const k of view.kpis) {
    const drill: Drill = { kind: 'kpi', id: k.id };
    assert.equal(view.rows.filter((r) => drillMatch(drill, r, now)).length, k.value, k.label);
  }
  for (const s of view.stages) {
    const drill: Drill = { kind: 'stage', id: s.id };
    assert.equal(view.rows.filter((r) => drillMatch(drill, r, now)).length, s.count, s.label);
  }
  for (const r of view.repos) {
    const drill: Drill = { kind: 'repo', id: r.repo };
    const shown = view.rows.filter((x) => drillMatch(drill, x, now));
    assert.equal(shown.filter((x) => !x.shippedAt).length, r.inflight, r.repo);
    assert.equal(
      r.segments.reduce((n, s) => n + s.count, 0),
      shown.length,
    );
  }
  for (const m of view.machines) {
    const drill: Drill = { kind: 'machine', id: m.machine.id };
    assert.equal(view.rows.filter((x) => drillMatch(drill, x, now)).length, m.sessions);
  }
  assert.equal(view.queue.length, view.kpis.find((k) => k.id === 'needs')?.value);
});

test('repos and machines: in flight, needs, stage segments, sessions by state', () => {
  const view = dashboardOf(OPS, now);
  assert.deepEqual(
    view.repos.map((r) => [r.repo, r.inflight, r.needs, r.segments.map((s) => s.short), r.note]),
    [
      [ATLAS, 6, 2, ['Session', 'PR', 'Review'], undefined],
      [BILL, 3, 2, ['PR', 'Review', 'Merged'], 'No deploys reported, so merges stop at Merged'],
      [MKT, 1, 1, ['Merged', 'Deployed'], undefined],
    ],
  );
  assert.deepEqual(
    view.machines.map((m) => [m.machine.name, m.status, m.live, m.states]),
    [
      [
        'rowan-mbp',
        'Online',
        4,
        [
          { state: 'needs', count: 1 },
          { state: 'working', count: 1 },
          { state: 'background', count: 1 },
          { state: 'idle', count: 1 },
        ],
      ],
      [
        'rowan-studio',
        'Online',
        4,
        [
          { state: 'working', count: 1 },
          { state: 'idle', count: 3 },
        ],
      ],
      ['build-box', 'Last seen 3h ago', 0, [{ state: 'offline', count: 1 }]],
    ],
  );
  assert.equal(view.online, 2);
});

test('needs you now: deploy failed, answer Claude, fix CI, conflicts, review; longest wait first', () => {
  const extra = row('rss', {
    repo: MKT,
    session: { id: 'rss', state: 'needs' },
    needs: ['answer'],
    needsSince: at(30),
  });
  const queue = queueOf([...ROWS, extra], now);
  assert.deepEqual(
    queue.map((q) => [q.row.id, q.reason, q.action, Math.round(q.waited / 60_000)]),
    [
      ['pricing', 'Deploy failed', 'Open deploy run', 9],
      ['rss', 'Answer Claude', 'Answer Claude', 30],
      ['auth', 'Answer Claude', 'Answer Claude', 2],
      ['checkout', 'Fix CI', 'Open failing check', 14],
      ['tax', 'Resolve conflicts', 'Open conflicts', 41],
      ['prorate', 'Address review', 'Open review', 22],
    ],
  );
  const where = Object.fromEntries(queue.map((q) => [q.row.id, [q.href, q.external]]));
  assert.deepEqual(where, {
    pricing: ['https://github.com/harbor-labs/marketing-site/actions/runs/1', true],
    rss: ['/?session=rss', false],
    auth: ['/?session=auth', false],
    checkout: [`https://github.com/${ATLAS}/pull/479/checks`, true],
    tax: ['/?session=tax&tab=changes', false],
    prorate: ['https://github.com/x/pull/215#r1', true],
  });
});

test('the queue holds its order: a new item joins where it ranks, a resolved one goes', () => {
  assert.deepEqual(settleQueue([], ['a', 'b', 'c']), ['a', 'b', 'c']);
  // b waited longer since and would rank first now: it stays put.
  assert.deepEqual(settleQueue(['a', 'b', 'c'], ['b', 'a', 'c']), ['a', 'b', 'c']);
  assert.deepEqual(settleQueue(['a', 'c'], ['a', 'n', 'c']), ['a', 'n', 'c']);
  assert.deepEqual(settleQueue(['a', 'b', 'c'], ['a', 'c', 'z']), ['a', 'c', 'z']);
});

test('throughput: seven days of merges and deploys, today last, and the median lead', () => {
  const day = (d: number, h = 0) =>
    new Date(Date.parse('2026-10-21T00:00:00Z') - d * 86_400_000 + h * 3_600_000).toISOString();
  const merge = (mergedAt: string, deployedAt?: string, startedHoursBefore?: number) => ({
    repo: ATLAS,
    number: 1,
    mergedAt,
    ...(deployedAt ? { deployedAt } : {}),
    ...(startedHoursBefore
      ? {
          sessionStartedAt: new Date(
            Date.parse(mergedAt) - startedHoursBefore * 3_600_000,
          ).toISOString(),
        }
      : {}),
  });
  const t = throughputOf(
    {
      ...OPS,
      merges: [
        merge(day(0, 9), day(0, 10), 2),
        merge(day(0, 8), undefined, 4),
        merge(day(2, 15), day(1, 9), 3),
        merge(day(6, 1)),
        // Eight days back: outside the week.
        merge(day(8, 1), undefined, 1),
      ],
    },
    now,
  );
  assert.deepEqual(
    t.days.map((d) => [d.label, d.merges, d.deploys]),
    [
      ['Thu', 1, 0],
      ['Fri', 0, 0],
      ['Sat', 0, 0],
      ['Sun', 0, 0],
      ['Mon', 1, 0],
      ['Tue', 0, 1],
      ['Today', 2, 1],
    ],
  );
  assert.deepEqual([t.merges, t.deploys, t.medianMs && span(t.medianMs)], [4, 2, '3h']);
  assert.equal(throughputOf(OPS, now).medianMs, undefined);
});

test('before GitHub reports, its totals and stages wait, and repos say where they come from', () => {
  const sessions = ROWS.filter((r) => r.session).map(({ pull: _p, ...r }) => ({
    ...r,
    needs: r.needs.filter((n) => n === 'answer'),
  }));
  const view = dashboardOf(
    { ...OPS, rows: sessions, github: { state: 'none' }, deployRepos: [] },
    now,
  );
  assert.deepEqual(
    view.kpis.filter((k) => KPIS.find((x) => x.id === k.id)?.github).map((k) => [k.value, k.sub]),
    [
      [undefined, 'Needs GitHub'],
      [undefined, 'Needs GitHub'],
      [undefined, 'Needs GitHub'],
      [undefined, 'Needs GitHub'],
    ],
  );
  assert.deepEqual(
    view.stages.map((s) => [s.id, s.off]),
    [
      ['session', false],
      ['pr', true],
      ['review', true],
      ['merged', true],
      ['deployed', true],
    ],
  );
  assert.equal(view.repos[0]?.note, 'From each session’s git remote');
  const first = sessions[0];
  assert.ok(first);
  assert.equal(kpiMatch('needs', first, now), true);
});

test('the drill-down lives in the URL', () => {
  const drills: Drill[] = [
    { kind: 'kpi', id: 'cifail' },
    { kind: 'stage', id: 'review' },
    { kind: 'repo', id: ATLAS },
    { kind: 'machine', id: 'mbp' },
    { kind: 'all' },
  ];
  for (const d of drills) assert.deepEqual(parseDrill(drillSearch(d)), d);
  assert.equal(drillSearch(undefined), '');
  assert.equal(parseDrill('?show=nonsense'), undefined);
  assert.deepEqual(
    drills.map((d) => drillLabel(d, OPS.machines)),
    [
      'CI failing',
      'Stage: Review',
      ATLAS,
      'Machine: rowan-mbp',
      'Everything in flight and shipped today',
    ],
  );
});

test('the feed says what happened, newest first, without repeats', () => {
  const ev = (id: string, minutes: number, extra: Partial<ActivityEvent>): ActivityEvent => ({
    id,
    at: at(minutes),
    kind: 'started',
    repo: BILL,
    title: 'Webhook retries',
    ...extra,
  });
  const views = [
    ev('1', 1, {}),
    ev('2', 4, { kind: 'ci', status: 'fail', number: 218, detail: 'unit-tests' }),
    ev('3', 22, { kind: 'review', number: 215, by: 'Sam Achebe', review: 'changes' }),
    ev('4', 38, { kind: 'merged', number: 484, title: 'Hotfix: header' }),
    ev('5', 60, { kind: 'deploy', status: 'pass', number: 474, detail: 'production' }),
    ev('6', 9, { kind: 'deploy', status: 'fail', number: 97, detail: 'production' }),
  ].map((e) => eventView(e, now));
  assert.deepEqual(
    views.map((v) => [v.time, v.glyph, v.what, v.subject, v.where]),
    [
      ['1m', { dot: 'working' }, 'Claude started', 'Webhook retries', 'billing-api'],
      ['4m', { ci: 'fail' }, 'CI failed on', '#218 unit-tests', 'billing-api'],
      ['22m', { icon: 'comment' }, 'Sam Achebe requested changes on', '#215', 'billing-api'],
      ['38m', { icon: 'branch' }, 'Merged', '#484 Hotfix: header', 'billing-api'],
      ['1h', { ci: 'pass' }, 'Deployed', '#474 to production', 'billing-api'],
      ['9m', { ci: 'fail' }, 'Deploy failed on', '#97 production', 'billing-api'],
    ],
  );
  const kept = [ev('a', 5, {}), ev('b', 10, {})];
  assert.deepEqual(
    mergeEvents(kept, [ev('c', 0, {}), ev('a', 5, {})]).map((e) => e.id),
    ['c', 'a', 'b'],
  );
});

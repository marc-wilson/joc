import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OperationPull, OperationRow, Operations } from '@joc/protocol';
import { ciText, opsNeeds, opsView, reviewNote, rowProps } from './operations.ts';

const now = Date.parse('2026-10-21T12:00:00.000Z');
const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

const pull = (extra: Partial<OperationPull> = {}): OperationPull => ({
  number: 479,
  url: 'https://github.com/harbor-labs/atlas-web/pull/479',
  state: 'open',
  author: 'ines',
  mine: true,
  additions: 412,
  deletions: 198,
  base: 'main',
  ci: 'pass',
  checks: { total: 7, done: 7, failing: [] },
  reviewers: [],
  conflicts: false,
  ...extra,
});

const row = (id: string, extra: Partial<OperationRow> = {}): OperationRow => ({
  id,
  repo: 'harbor-labs/atlas-web',
  title: `Work ${id}`,
  branch: `feat/${id}`,
  since: at(60),
  activeAt: at(14),
  needs: [],
  ...extra,
});

const ops = (rows: OperationRow[], deployRepos: string[] = []): Operations => ({
  rows,
  deployRepos,
  github: { state: 'reported', status: 'ok', updatedAt: at(1) },
});

test('the CI cell names failing checks, counts what runs, and says when a draft ran none', () => {
  assert.deepEqual(
    ciText(pull({ ci: 'fail', checks: { total: 7, done: 7, failing: ['lint', 'e2e-checkout'] } })),
    {
      detail: '2',
      note: 'lint, e2e-checkout',
    },
  );
  assert.deepEqual(ciText(pull({ ci: 'pending', checks: { total: 7, done: 3, failing: [] } })), {
    detail: '3/7',
    note: '4 checks running',
  });
  assert.deepEqual(ciText(pull()), { note: '7 checks' });
  assert.deepEqual(ciText(pull({ ci: 'skipped', state: 'draft' })), {
    note: 'Draft, checks not run',
  });
});

test('the review line names the reviewer, or counts approvals', () => {
  const people = [{ login: 'mei' }, { login: 'theo' }];
  assert.equal(reviewNote(pull({ review: 'approved', reviewers: people })), '2 approvals');
  assert.equal(reviewNote(pull({ review: 'changes', reviewers: [{ login: 'sam' }] })), 'sam');
});

test('a row needing you says why; cells link into JOC or out to GitHub', () => {
  const r = row('a', {
    session: { id: 'sess-a', state: 'idle', activity: 'Pushed 3 commits' },
    pull: pull({ ci: 'fail', checks: { total: 3, done: 3, failing: ['lint'] } }),
    needs: ['ci'],
  });
  const p = rowProps(r, { now, deployed: false });
  assert.equal(p.needs, 'Fix CI');
  assert.equal(p.work.href, '/?session=sess-a');
  assert.equal(p.pr?.link.href, '/?session=sess-a&tab=changes');
  assert.equal(p.ci?.link.external, true);
  assert.equal(p.ci?.link.label, 'Open the lint check');
  // The failure never drops from the pipeline; the pull request itself goes first.
  assert.deepEqual(
    p.pieces.map((x: { text: string; priority: number }) => [x.text, x.priority]),
    [
      ['#479 Open', 3],
      ['CI failed 1', 0],
    ],
  );
});

test('a pull request with no session opens on GitHub and offers to start a session', () => {
  const started: string[] = [];
  const p = rowProps(row('b', { pull: pull({ mine: false, author: 'harbor-bot' }) }), {
    now,
    deployed: false,
    onStart: (r) => started.push(r.id),
  });
  assert.equal(p.work.external, true);
  assert.equal(p.meta, 'by harbor-bot · 14m');
  p.start?.onClick?.();
  assert.deepEqual(started, ['b']);
});

test('conflicts use the needs diamond, and a merge shows its deploy only where reported', () => {
  const conflicted = rowProps(row('c', { pull: pull({ conflicts: true }), needs: ['conflicts'] }), {
    now,
    deployed: false,
  });
  assert.equal(conflicted.merged?.kind, 'conflicts');
  assert.equal(
    conflicted.pieces.find((x: { text: string }) => x.text === 'Conflicts')?.dot,
    'needs',
  );
  const merged = row('d', {
    pull: pull({
      state: 'merged',
      mergedAt: at(38),
      mergeCommit: 'abc1234',
      deploy: { environment: 'production', status: 'pending', at: at(3) },
    }),
  });
  const shown = rowProps(merged, { now, deployed: true });
  assert.equal(shown.merged?.link.href, 'https://github.com/harbor-labs/atlas-web/commit/abc1234');
  assert.equal(shown.deploy?.note, 'production · 3m');
  assert.equal(rowProps(merged, { now, deployed: false }).deploy, undefined);
});

test('groups count every row; filters only pick; shipped rows fold apart once allowed', () => {
  const rows = [
    row('a', { needs: ['answer'], session: { id: 'a', state: 'needs' } }),
    row('b', { repo: 'harbor-labs/billing-api', pull: pull() }),
    row('c', { pull: pull({ state: 'merged', mergedAt: at(30) }), shippedAt: at(30) }),
  ];
  const order = new Map(rows.map((r, i) => [r.id, i]));
  const base = { query: '', now, order };
  const all = opsView(ops(rows), { ...base, filter: 'all', folded: new Set(['c']) });
  assert.deepEqual(
    all.groups.map((g) => [g.repo, g.all.length, g.needs]),
    [
      ['harbor-labs/atlas-web', 1, 1],
      ['harbor-labs/billing-api', 1, 0],
    ],
  );
  assert.deepEqual(all.counts, { all: 2, needs: 1, review: 1, shipped: 1 });
  assert.deepEqual(
    all.shipped.map((r) => r.id),
    ['c'],
  );
  const needs = opsView(ops(rows), { ...base, filter: 'needs', folded: new Set(['c']) });
  assert.deepEqual(
    needs.groups.map((g) => g.rows.map((r) => r.id)),
    [['a'], []],
  );
  // Not folded yet (the pointer is on the table): it stays in its group.
  const held = opsView(ops(rows), { ...base, filter: 'all', folded: new Set() });
  assert.deepEqual(
    held.groups[0]?.rows.map((r) => r.id),
    ['a', 'c'],
  );
  assert.equal(opsNeeds(ops(rows)), 1);
});

test('rows keep the order they arrived in, and the text filter matches #numbers', () => {
  const rows = [row('late', { pull: pull({ number: 12 }) }), row('early')];
  const order = new Map([
    ['early', 0],
    ['late', 1],
  ]);
  const v = opsView(ops(rows), { filter: 'all', query: '', now, order, folded: new Set() });
  assert.deepEqual(
    v.groups[0]?.rows.map((r) => r.id),
    ['early', 'late'],
  );
  const typed = opsView(ops(rows), { filter: 'all', query: '#12', now, order, folded: new Set() });
  assert.deepEqual(
    typed.groups[0]?.rows.map((r) => r.id),
    ['late'],
  );
});

test('the Deployed column shows only when a repo on screen reports deploys', () => {
  const rows = [row('a'), row('b', { repo: 'harbor-labs/billing-api' })];
  const order = new Map<string, number>();
  const view = (filter: 'all' | 'needs', deployRepos: string[]) =>
    opsView(ops(rows, deployRepos), { filter, query: '', now, order, folded: new Set() });
  assert.equal(view('all', []).deployed, false);
  assert.equal(view('all', ['harbor-labs/atlas-web']).deployed, true);
  // Filtered down to nothing from that repo: no column.
  assert.equal(view('needs', ['harbor-labs/atlas-web']).deployed, false);
});

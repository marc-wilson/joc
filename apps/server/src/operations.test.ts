// Operations' rows from sessions and pull requests: how they join, need you and ship. Made-up
// harbor-labs data only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Operations, type PullRequest, type Session } from '@joc/protocol';
import type { GitHubLists } from './github-data.ts';
import { buildOperations } from './operations.ts';

const NOW = Date.parse('2026-10-21T12:00:00.000Z');
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

const session = (id: string, extra: Partial<Session> = {}): Session => ({
  id,
  title: `Session ${id}`,
  repo: 'harbor-labs/atlas-web',
  state: 'working',
  activity: 'Editing src/auth.ts',
  startedAt: at(60),
  updatedAt: at(1),
  ...extra,
});

const pr = (number: number, extra: Partial<PullRequest> = {}): PullRequest => ({
  number,
  title: `Pull request ${number}`,
  url: `https://github.com/harbor-labs/atlas-web/pull/${number}`,
  repo: 'harbor-labs/atlas-web',
  branch: `feat/${number}`,
  author: 'ines',
  updatedAt: at(5),
  createdAt: at(30),
  draft: false,
  additions: 10,
  deletions: 2,
  ci: 'pass',
  ...extra,
});

const lists = (
  mine: PullRequest[] = [],
  reviewRequested: PullRequest[] = [],
  more: Partial<GitHubLists> = {},
): GitHubLists => ({
  snapshot: { state: 'reported', status: 'ok', mine, reviewRequested, updatedAt: at(1) },
  recent: [],
  deployRepos: [],
  ...more,
});

const build = (sessions: Session[], github: GitHubLists) =>
  Operations.parse(buildOperations({ sessions, github, now: NOW }));

test('a pull request joins the session on its repo and branch, one row for both', () => {
  const ops = build(
    [session('a', { branch: 'feat/1', repo: 'Harbor-Labs/atlas-web' }), session('b')],
    lists([pr(1)]),
  );
  assert.deepEqual(
    ops.rows.map((r) => [r.id, r.pull?.number]),
    [
      ['s:a', 1],
      ['s:b', undefined],
    ],
  );
  // The session's own name, the pull request's spelling of the repo.
  assert.equal(ops.rows[0]?.title, 'Session a');
  assert.equal(ops.rows[0]?.repo, 'harbor-labs/atlas-web');
});

test('a pull request no session works on is a row of its own, titled by the pull request', () => {
  const ops = build([session('a', { startedAt: at(10) })], lists([], [pr(2, { author: 'theo' })]));
  const only = ops.rows.find((r) => r.id === 'pr:harbor-labs/atlas-web#2');
  assert.equal(only?.title, 'Pull request 2');
  assert.equal(only?.session, undefined);
  assert.equal(only?.pull?.mine, false);
  // Oldest first: the pull request opened 30 minutes ago, the session 10.
  assert.deepEqual(
    ops.rows.map((r) => r.id),
    ['pr:harbor-labs/atlas-web#2', 's:a'],
  );
});

test('of two sessions on one branch, the most recently active gets the pull request', () => {
  const ops = build(
    [
      session('old', { branch: 'feat/1', startedAt: at(90), updatedAt: at(20) }),
      session('new', { branch: 'feat/1', startedAt: at(50), updatedAt: at(2) }),
    ],
    lists([pr(1)]),
  );
  assert.deepEqual(
    ops.rows.map((r) => [r.id, r.pull?.number]),
    [
      ['s:old', undefined],
      ['s:new', 1],
    ],
  );
});

test('a review session joins the pull request it reviews, whatever its branch', () => {
  const ops = build(
    [session('cr', { branch: 'main', review: { repo: 'harbor-labs/atlas-web', number: 3 } })],
    lists([], [pr(3)]),
  );
  assert.deepEqual(
    ops.rows.map((r) => [r.id, r.pull?.number]),
    [['s:cr', 3]],
  );
});

test('a session waiting on you needs you, with its question as the activity', () => {
  const ops = build(
    [
      session('a', {
        state: 'needs',
        waiting: {
          kind: 'question',
          id: 'wait-0001',
          questions: [{ question: 'Keep the old cookie name?', options: [], multiSelect: false }],
        },
      }),
    ],
    lists(),
  );
  assert.deepEqual(ops.rows[0]?.needs, ['answer']);
  assert.equal(ops.rows[0]?.session?.activity, 'Keep the old cookie name?');
});

test('your pull request needs you when CI fails, it conflicts or changes are requested', () => {
  const ops = build(
    [],
    lists(
      [
        pr(1, {
          ci: 'fail',
          checks: [
            { name: 'lint', status: 'fail' },
            { name: 'e2e-checkout', status: 'fail' },
            { name: 'build', status: 'pass' },
          ],
        }),
        pr(2, { mergeable: false }),
        pr(3, {
          review: 'Changes requested',
          reviews: [{ by: { login: 'sam' }, state: 'changes-requested' }],
        }),
        pr(4, { ci: 'pending' }),
      ],
      [pr(5, { ci: 'fail', review: 'Changes requested', mergeable: false })],
    ),
  );
  const needs = Object.fromEntries(ops.rows.map((r) => [r.pull?.number, r.needs]));
  assert.deepEqual(needs, { 1: ['ci'], 2: ['conflicts'], 3: ['review'], 4: [], 5: [] });
  const failing = ops.rows.find((r) => r.pull?.number === 1)?.pull?.checks;
  assert.deepEqual(failing, { total: 3, done: 3, failing: ['lint', 'e2e-checkout'] });
  const review = ops.rows.find((r) => r.pull?.number === 3)?.pull;
  assert.deepEqual([review?.review, review?.reviewers], ['changes', [{ login: 'sam' }]]);
});

test('needs come most pressing first: Claude waiting, then CI, conflicts, review', () => {
  const ops = build(
    [session('a', { branch: 'feat/1', state: 'needs' })],
    lists([pr(1, { ci: 'fail', mergeable: false, review: 'Changes requested' })]),
  );
  assert.deepEqual(ops.rows[0]?.needs, ['answer', 'ci', 'conflicts', 'review']);
});

test('a merged pull request ships at once in a repo that reports no deploys', () => {
  const merged = pr(9, { state: 'merged', closedAt: at(40), mergedAt: at(40) });
  const ops = build([session('a', { branch: 'feat/9' })], lists([], [], { recent: [merged] }));
  assert.equal(ops.rows[0]?.pull?.state, 'merged');
  assert.equal(ops.rows[0]?.shippedAt, at(40));
});

test('where deploys are reported, a merge ships once deployed, and a failed one needs you', () => {
  const deploy = (status: 'pass' | 'fail' | 'pending') => ({
    environment: 'production',
    status,
    at: at(3),
  });
  const merged = (n: number, status: 'pass' | 'fail' | 'pending') =>
    pr(n, {
      state: 'merged',
      closedAt: at(40),
      mergedAt: at(40),
      mergeCommit: 'abc1234',
      deploy: deploy(status),
    });
  const ops = build(
    [],
    lists([], [], {
      recent: [merged(1, 'pending'), merged(2, 'pass'), merged(3, 'fail')],
      deployRepos: ['harbor-labs/atlas-web'],
    }),
  );
  const by = Object.fromEntries(ops.rows.map((r) => [r.pull?.number, [r.shippedAt, r.needs]]));
  assert.deepEqual(by, {
    1: [undefined, []],
    2: [at(3), []],
    3: [undefined, ['deploy']],
  });
});

test('a closed pull request leaves after a day; an open copy wins over a closed one', () => {
  const ops = build(
    [],
    lists([pr(1)], [], {
      recent: [
        pr(1, { state: 'closed', closedAt: at(10) }),
        pr(2, { state: 'closed', closedAt: at(10) }),
        pr(3, { state: 'merged', closedAt: at(25 * 60), mergedAt: at(25 * 60) }),
      ],
    }),
  );
  assert.deepEqual(
    ops.rows.map((r) => [r.pull?.number, r.pull?.state]),
    [
      [1, 'open'],
      [2, 'closed'],
    ],
  );
});

test('a draft reads as a draft, and the review shows who reviewed or is asked', () => {
  const ops = build(
    [],
    lists([
      pr(1, { draft: true, ci: 'skipped' }),
      pr(2, { review: 'Review requested', requestedReviewers: [{ login: 'mei' }] }),
      pr(3, {
        review: 'Approved',
        reviews: [
          { by: { login: 'mei' }, state: 'commented' },
          { by: { login: 'mei' }, state: 'approved', url: 'https://github.com/r/1' },
          { by: { login: 'theo' }, state: 'approved' },
        ],
      }),
      pr(4, { reviews: [{ by: { login: 'theo' }, state: 'commented' }] }),
    ]),
  );
  const pulls = ops.rows.map((r) => r.pull);
  assert.equal(pulls[0]?.state, 'draft');
  assert.deepEqual(
    pulls.slice(1).map((p) => [p?.review, p?.reviewers.map((x) => x.login)]),
    [
      ['required', ['mei']],
      ['approved', ['mei', 'theo']],
      ['commented', ['theo']],
    ],
  );
  assert.equal(pulls[2]?.reviewUrl, 'https://github.com/r/1');
});

test('without GitHub, rows are the sessions alone, and say GitHub has not reported', () => {
  const ops = build([session('a'), session('b', { startedAt: at(5) })], {
    snapshot: { state: 'none' },
    recent: [],
    deployRepos: [],
  });
  assert.deepEqual(
    ops.rows.map((r) => r.id),
    ['s:a', 's:b'],
  );
  assert.deepEqual(ops.github, { state: 'none' });
});

test("a quiet session says so: its machine stopped reporting, it didn't end", () => {
  const ops = build(
    [session('a', { updatedAt: at(10) }), session('b', { state: 'offline', updatedAt: at(10) })],
    lists(),
  );
  assert.deepEqual(
    ops.rows.map((r) => r.session?.quiet),
    [true, undefined],
  );
});

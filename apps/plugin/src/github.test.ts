import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { type GraphNode, githubDue, type Rollup, toChecks, toPullRequest } from './github.ts';

const node = (rollup: Rollup, extra: Partial<GraphNode> = {}): GraphNode => ({
  number: 238,
  title: 'Migrate transactional mail to Resend',
  url: 'https://github.example/harbor-labs/atlas-api/pull/238',
  isDraft: false,
  additions: 412,
  deletions: 198,
  reviewDecision: 'REVIEW_REQUIRED',
  updatedAt: '2026-10-18T10:00:00Z',
  headRefName: 'feat/resend-mailer',
  repository: { nameWithOwner: 'harbor-labs/atlas-api' },
  author: { login: 'priya' },
  commits: { nodes: [{ commit: { statusCheckRollup: rollup } }] },
  ...extra,
});

test('CI state and counts come from the last commit', () => {
  const pending = toPullRequest(
    node({
      state: 'PENDING',
      contexts: {
        totalCount: 12,
        checkRunCountsByState: [
          { state: 'SUCCESS', count: 5 },
          { state: 'SKIPPED', count: 1 },
          { state: 'IN_PROGRESS', count: 6 },
        ],
      },
    }),
  );
  assert.deepEqual([pending?.ci, pending?.ciDetail], ['pending', '6/12']);
  assert.equal(toPullRequest(node({ state: 'SUCCESS', contexts: { totalCount: 0 } }))?.ci, 'pass');
  assert.equal(toPullRequest(node({ state: 'ERROR' }))?.ci, 'fail');
  assert.equal(toPullRequest(node(null))?.ci, 'skipped');
});

test('a result maps to a pull request, and a partial one is dropped', () => {
  const pr = toPullRequest(node(null, { reviewDecision: 'CHANGES_REQUESTED', author: null }));
  assert.deepEqual(
    [pr?.repo, pr?.branch, pr?.review, pr?.author, pr?.updatedAt],
    [
      'harbor-labs/atlas-api',
      'feat/resend-mailer',
      'Changes requested',
      'ghost',
      '2026-10-18T10:00:00.000Z',
    ],
  );
  assert.equal(toPullRequest({}), undefined);
  assert.equal(toPullRequest(node(null, { headRefName: undefined })), undefined);
});

test('a pull request carries its base branch and changed files', () => {
  const pr = toPullRequest(
    node(null, {
      baseRefName: 'main',
      changedFiles: 3,
      files: {
        nodes: [
          { path: 'src/mail/resend.ts', additions: 120, deletions: 0, changeType: 'ADDED' },
          { path: 'src/mail/smtp.ts', additions: 0, deletions: 90, changeType: 'DELETED' },
          { path: 'package.json', additions: 2, deletions: 1, changeType: 'CHANGED' },
          { additions: 1, deletions: 1, changeType: 'MODIFIED' },
        ],
      },
    }),
  );
  assert.equal(pr?.base, 'main');
  assert.equal(pr?.changedFiles, 3);
  assert.deepEqual(
    pr?.files?.map((f) => [f.path, f.status, f.additions, f.deletions]),
    [
      ['src/mail/resend.ts', 'added', 120, 0],
      ['src/mail/smtp.ts', 'deleted', 0, 90],
      ['package.json', 'modified', 2, 1],
    ],
  );
  // GitHub left them out: nothing is made up.
  const bare = toPullRequest(node(null));
  assert.deepEqual(
    [bare?.base, bare?.files, bare?.changedFiles],
    [undefined, undefined, undefined],
  );
});

test('GitHub is read at most once a minute per machine', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'joc-github-')), 'stamp');
  assert.equal(githubDue(1_000_000, file), true);
  assert.equal(githubDue(1_030_000, file), false);
  assert.equal(githubDue(1_061_000, file), true);
});

test("a pull request lists its last commit's checks, each with its outcome", () => {
  const checks = toChecks([
    {
      name: 'build',
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
      startedAt: '2026-10-18T10:00:00Z',
      completedAt: '2026-10-18T10:02:10Z',
    },
    { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
    { name: 'e2e', status: 'IN_PROGRESS', conclusion: null, startedAt: '2026-10-18T10:00:00Z' },
    { name: 'preview', status: 'COMPLETED', conclusion: 'SKIPPED' },
    { context: 'ci/lint', state: 'SUCCESS' },
    { context: 'ci/deploy', state: 'PENDING' },
    {},
  ]);
  assert.deepEqual(checks, [
    { name: 'build', status: 'pass', seconds: 130 },
    { name: 'test', status: 'fail' },
    { name: 'e2e', status: 'pending' },
    { name: 'preview', status: 'skipped' },
    { name: 'ci/lint', status: 'pass' },
    { name: 'ci/deploy', status: 'pending' },
  ]);
  assert.equal(toChecks(undefined), undefined);
  assert.equal(toPullRequest(node(null))?.checks, undefined);
});

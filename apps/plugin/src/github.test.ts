import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { type GraphNode, githubDue, type Rollup, toPullRequest } from './github.ts';

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

test('GitHub is read at most once a minute per machine', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'joc-github-')), 'stamp');
  assert.equal(githubDue(1_000_000, file), true);
  assert.equal(githubDue(1_030_000, file), false);
  assert.equal(githubDue(1_061_000, file), true);
});

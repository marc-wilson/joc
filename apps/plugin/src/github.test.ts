import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as protocol from '@joc/protocol';
import {
  clipBody,
  type GraphNode,
  githubDue,
  MAX_CHECK_DETAIL,
  MAX_PR_BODY,
  MAX_PR_CHECKS,
  MAX_PR_CLOSES,
  MAX_PR_LABELS,
  MAX_PR_REVIEWERS,
  MAX_PR_REVIEWS,
  type Rollup,
  toChecks,
  toPullRequest,
} from './github.ts';

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
    { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', title: '\n2 failed in auth\nmore' },
    { name: 'e2e', status: 'IN_PROGRESS', conclusion: null, startedAt: '2026-10-18T10:00:00Z' },
    { name: 'preview', status: 'COMPLETED', conclusion: 'SKIPPED', title: '  ' },
    { context: 'ci/lint', state: 'SUCCESS', description: 'No problems' },
    { context: 'ci/deploy', state: 'PENDING', description: 'x'.repeat(300) },
    {},
  ]);
  assert.deepEqual(checks?.slice(0, 5), [
    { name: 'build', status: 'pass', seconds: 130 },
    { name: 'test', status: 'fail', detail: '2 failed in auth' },
    { name: 'e2e', status: 'pending' },
    { name: 'preview', status: 'skipped' },
    { name: 'ci/lint', status: 'pass', detail: 'No problems' },
  ]);
  // A long one is cut to the protocol's limit.
  assert.equal(checks?.[5]?.detail?.length, MAX_CHECK_DETAIL);
  assert.equal(checks?.length, 6);
  assert.equal(toChecks(undefined), undefined);
  assert.equal(toPullRequest(node(null))?.checks, undefined);
});

test("the limits match the protocol's", () => {
  assert.deepEqual(
    [
      MAX_PR_CHECKS,
      MAX_CHECK_DETAIL,
      MAX_PR_BODY,
      MAX_PR_REVIEWS,
      MAX_PR_REVIEWERS,
      MAX_PR_LABELS,
      MAX_PR_CLOSES,
    ],
    [
      protocol.MAX_PR_CHECKS,
      protocol.MAX_CHECK_DETAIL,
      protocol.MAX_PR_BODY,
      protocol.MAX_PR_REVIEWS,
      protocol.MAX_PR_REVIEWERS,
      protocol.MAX_PR_LABELS,
      protocol.MAX_PR_CLOSES,
    ],
  );
});

test('a pull request carries what a review shows, each field checked', () => {
  const avatar = 'https://avatars.githubusercontent.com/u/41?v=4';
  const pr = toPullRequest(
    node(null, {
      state: 'OPEN',
      createdAt: '2026-10-17T09:00:00Z',
      body: 'Swaps SMTP for Resend.\n\nCloses #230.',
      headRefOid: 'c0ffee0c0ffee0c0ffee0c0ffee0c0ffee0c0ffe',
      mergeable: 'CONFLICTING',
      author: { __typename: 'User', login: 'priya', name: 'Priya N', avatarUrl: avatar },
      commits: { totalCount: 6, nodes: [] },
      reviews: {
        nodes: [
          {
            state: 'APPROVED',
            submittedAt: '2026-10-18T09:00:00Z',
            author: { __typename: 'Bot', login: 'harbor-bot', avatarUrl: avatar },
          },
          { state: 'PENDING', author: { login: 'tomas' } },
          { state: 'COMMENTED', author: null },
        ],
      },
      reviewRequests: {
        nodes: [
          {
            requestedReviewer: {
              __typename: 'User',
              login: 'tomas',
              avatarUrl: 'https://x.example/a.png',
            },
          },
          { requestedReviewer: { __typename: 'Team', slug: 'mail', name: 'Mail' } },
          { requestedReviewer: null },
        ],
      },
      labels: {
        nodes: [
          { name: 'infra', color: '0e8a16' },
          { name: 'odd', color: 'blue' },
        ],
      },
      milestone: { title: 'Q4', number: 2, url: 'https://github.example/m/2', dueOn: null },
      closingIssuesReferences: {
        nodes: [
          {
            number: 230,
            title: 'Mail bounces',
            url: 'https://github.example/harbor-labs/atlas-api/issues/230',
            repository: { nameWithOwner: 'harbor-labs/atlas-api' },
          },
        ],
      },
    }),
  );
  // Everything the server checks passes.
  assert.equal(protocol.PullRequest.safeParse(pr).success, true);
  assert.deepEqual(pr?.authorProfile, { login: 'priya', name: 'Priya N', avatarUrl: avatar });
  assert.deepEqual(
    [pr?.state, pr?.createdAt, pr?.mergeable, pr?.commits, pr?.headSha?.length],
    ['open', '2026-10-17T09:00:00.000Z', false, 6, 40],
  );
  assert.equal(pr?.body, 'Swaps SMTP for Resend.\n\nCloses #230.');
  assert.deepEqual(pr?.reviews, [
    {
      by: { login: 'harbor-bot', avatarUrl: avatar, bot: true },
      state: 'approved',
      submittedAt: '2026-10-18T09:00:00.000Z',
    },
  ]);
  // An avatar from anywhere but GitHub's image host is left out.
  assert.deepEqual(pr?.requestedReviewers, [{ login: 'tomas' }]);
  assert.deepEqual(pr?.requestedTeams, [{ slug: 'mail', name: 'Mail' }]);
  assert.deepEqual(pr?.labels, [{ name: 'infra', color: '0e8a16' }]);
  assert.deepEqual(pr?.milestone, { title: 'Q4', number: 2, url: 'https://github.example/m/2' });
  assert.deepEqual(
    pr?.closes?.map((i) => [i.repo, i.number, i.title]),
    [['harbor-labs/atlas-api', 230, 'Mail bounces']],
  );
});

test('a long description is cut, and says so', () => {
  const pr = toPullRequest(node(null, { body: 'x'.repeat(MAX_PR_BODY + 1) }));
  assert.deepEqual([pr?.body?.length, pr?.bodyTruncated], [MAX_PR_BODY, true]);
  assert.equal(protocol.PullRequest.safeParse(pr).success, true);
  assert.deepEqual(clipBody(''), {});
});

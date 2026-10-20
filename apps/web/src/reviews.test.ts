import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PullRequest, Review, Session } from '@joc/protocol';
import { findPR, prFromSearch, prHref, reviewSessions, reviewStatus } from './reviews.ts';

const pr: PullRequest = {
  number: 238,
  title: 'Migrate transactional mail to Resend',
  url: 'https://github.example/harbor-labs/atlas-api/pull/238',
  repo: 'harbor-labs/atlas-api',
  branch: 'feat/resend-mailer',
  author: 'priya',
  updatedAt: '2026-10-18T10:00:00.000Z',
  draft: false,
  additions: 1,
  deletions: 1,
  ci: 'pending',
};

const session = (id: string, extra: Partial<Session> = {}): Session => ({
  id,
  repo: 'harbor-labs/atlas-api',
  branch: 'main',
  state: 'idle',
  startedAt: '2026-10-18T09:00:00.000Z',
  updatedAt: '2026-10-18T09:30:00.000Z',
  ...extra,
});

test("a PR's page address names it, and reads back", () => {
  assert.equal(prHref(pr), '/pr?repo=harbor-labs%2Fatlas-api&number=238');
  assert.deepEqual(prFromSearch('?repo=harbor-labs%2Fatlas-api&number=238'), {
    repo: 'harbor-labs/atlas-api',
    number: 238,
  });
  assert.equal(prFromSearch('?repo=harbor-labs%2Fatlas-api&number=x'), undefined);
  assert.equal(prFromSearch('?number=238'), undefined);
  assert.equal(findPR([[], [pr]], { repo: pr.repo, number: 238 }), pr);
  assert.equal(findPR([[pr]], { repo: 'harbor-labs/tide', number: 238 }), undefined);
});

test("a review runs in an open session on the PR's repo, its own branch's first", () => {
  const sessions = [
    session('main'),
    session('elsewhere', { repo: 'harbor-labs/tide' }),
    session('gone', { state: 'offline' }),
    session('on-branch', { branch: 'feat/resend-mailer', state: 'working' }),
  ];
  assert.deepEqual(
    reviewSessions(pr, sessions).map((s) => s.id),
    ['on-branch', 'main'],
  );
});

test('a review says where it stands', () => {
  const review: Review = {
    id: 'r1',
    repo: pr.repo,
    number: 238,
    sessionId: 's1',
    kind: 'new',
    prompt: '/code-review 238',
    status: 'starting',
    createdAt: '2026-10-18T10:00:00.000Z',
  };
  assert.match(reviewStatus(review, undefined), /Waiting for the session/);
  assert.match(
    reviewStatus({ ...review, status: 'started' }, undefined),
    /Waiting for it to report/,
  );
  assert.equal(
    reviewStatus({ ...review, status: 'started' }, session('s1')),
    'Running in a new session',
  );
  assert.equal(
    reviewStatus({ ...review, status: 'failed', detail: 'claude: command not found' }, undefined),
    'claude: command not found',
  );
  assert.equal(
    reviewStatus({ ...review, kind: 'session', status: 'sent' }, undefined),
    'Sent to the session',
  );
});

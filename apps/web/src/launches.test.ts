import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Launch, PullRequest, Session } from '@joc/protocol';
import { launched, launchFrom, launchStatus } from './launches.ts';
import { findPR, prFromSearch, prHref } from './reviews.ts';

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

test('a new session starts from a live one, on the branch asked for if there is one', () => {
  const sessions = [
    session('gone', { state: 'offline', branch: 'feat/resend-mailer' }),
    session('main'),
    session('on-branch', { branch: 'feat/resend-mailer', state: 'working' }),
  ];
  assert.equal(launchFrom(sessions, pr.branch)?.id, 'on-branch');
  assert.equal(launchFrom(sessions)?.id, 'main');
  assert.equal(launchFrom(sessions, 'feat/other')?.id, 'main');
  assert.equal(launchFrom([session('gone', { state: 'offline' })]), undefined);
});

test('a launch says where it stands, and finds its session once it reports', () => {
  const launch: Launch = {
    id: 'l1',
    from: 'main',
    repo: pr.repo,
    status: 'starting',
    createdAt: '2026-10-18T10:00:00.000Z',
  };
  const id = '9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';
  const started: Launch = { ...launch, status: 'started', sessionId: id };
  assert.match(launchStatus(launch, undefined), /Waiting for the session/);
  assert.match(launchStatus(started, undefined), /Waiting for it to report/);
  assert.match(launchStatus({ ...launch, status: 'started' }, undefined), /can't see it/);
  assert.equal(launchStatus(started, session(id)), 'Running in a new session');
  assert.equal(launchStatus(started, session(id, { state: 'offline' })), 'Ran in a new session');
  assert.equal(
    launchStatus({ ...launch, status: 'failed', detail: 'claude: command not found' }, undefined),
    'claude: command not found',
  );
  assert.equal(launched(started, [session('main')]), undefined);
  assert.equal(launched(started, [session(id)])?.id, id);
  assert.equal(launched(launch, [session(id)]), undefined);
});

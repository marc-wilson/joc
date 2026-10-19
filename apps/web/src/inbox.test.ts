import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GitHubNotification, PullRequest, Session } from '@joc/protocol';
import { freshThreads, newlyNeeding, seenNow, threadAlert } from './alerts.ts';
import { groupThreads, markOf, mergeThreads, referenceOf, verbOf } from './inbox.ts';
import { sessionForThread } from './links.ts';

const thread = (id: string, extra: Partial<GitHubNotification> = {}): GitHubNotification => ({
  id,
  reason: 'comment',
  title: `Thread ${id}`,
  type: 'PullRequest',
  repo: 'harbor-labs/atlas-web',
  url: `https://github.com/harbor-labs/atlas-web/pull/${id}`,
  updatedAt: '2026-10-18T10:00:00.000Z',
  number: Number(id),
  ...extra,
});

test('rows keep their place: updates land in place, read ones stay, new ones go last', () => {
  const first = mergeThreads([], [thread('1'), thread('2'), thread('3')]);
  const next = mergeThreads(first, [thread('3', { title: 'Renamed' }), thread('4'), thread('1')]);
  assert.deepEqual(
    next.map((t) => [t.id, t.title, t.read]),
    [
      ['1', 'Thread 1', false],
      ['2', 'Thread 2', true],
      ['3', 'Renamed', false],
      ['4', 'Thread 4', false],
    ],
  );
});

test('groups come in a fixed order, what needs you first, empty ones left out', () => {
  const list = mergeThreads(
    [],
    [
      thread('1', { reason: 'subscribed' }),
      thread('2', { reason: 'comment' }),
      thread('3', { reason: 'ci_activity', type: 'CheckSuite', alert: 'ci-failed' }),
      thread('4', { reason: 'team_mention', alert: 'mention' }),
      thread('5', { reason: 'review_requested', alert: 'review' }),
      thread('6', { reason: 'something_new' }),
    ],
  );
  assert.deepEqual(
    groupThreads(list).map(([g, rows]) => [g.label, rows.map((t) => t.id)]),
    [
      ['Review requested', ['5']],
      ['Mentioned', ['4']],
      ['CI', ['3']],
      ['Commented', ['2']],
      ['Subscribed', ['1']],
      ['Other', ['6']],
    ],
  );
  assert.equal(markOf(thread('3', { reason: 'ci_activity', alert: 'ci-failed' })), 'ci-failed');
  assert.equal(markOf(thread('7', { reason: 'ci_activity' })), 'other');
  assert.equal(markOf(thread('4', { reason: 'mention' })), 'mention');
  assert.equal(
    verbOf(thread('5', { reason: 'review_requested' })),
    'Review requested from you · pull request',
  );
  assert.equal(referenceOf(thread('5')), 'atlas-web#5');
  assert.equal(referenceOf(thread('8', { number: undefined })), 'atlas-web');
});

const session = (id: string, branch: string, state: Session['state'] = 'idle'): Session => ({
  id,
  repo: 'harbor-labs/atlas-web',
  branch,
  state,
  startedAt: '2026-10-18T09:00:00.000Z',
  updatedAt: '2026-10-18T10:00:00.000Z',
});

test("a thread links to the session on its pull request's or CI run's branch", () => {
  const pr: PullRequest = {
    number: 42,
    title: 'Fix the login loop',
    url: 'https://github.com/harbor-labs/atlas-web/pull/42',
    repo: 'harbor-labs/atlas-web',
    branch: 'fix/login-loop',
    author: 'priya',
    updatedAt: '2026-10-18T10:00:00.000Z',
    draft: false,
    additions: 1,
    deletions: 1,
    ci: 'pass',
  };
  const sessions = [session('a', 'fix/login-loop'), session('b', 'main')];
  assert.equal(sessionForThread(thread('42'), [pr], sessions)?.id, 'a');
  assert.equal(sessionForThread(thread('43'), [pr], sessions), undefined);
  const ci = thread('9', { type: 'CheckSuite', number: undefined, branch: 'main' });
  assert.equal(sessionForThread(ci, [], sessions)?.id, 'b');
});

test('a browser notification fires once per thread, and never for what was already there', () => {
  const seen = seenNow([thread('1', { alert: 'review' })]);
  const fresh = freshThreads(seen, [
    thread('1', { alert: 'review' }),
    thread('2', { alert: 'mention' }),
    thread('3'),
  ]);
  assert.deepEqual(
    fresh.map((t) => t.id),
    ['2'],
  );
  assert.deepEqual(freshThreads(seen, [thread('2', { alert: 'mention' })]), []);
  assert.equal(threadAlert(fresh[0] ?? thread('0')).title, 'You were mentioned');
});

test('a session notifies when it goes to needs, not while it stays there', () => {
  const before = new Map<string, Session['state']>([
    ['a', 'working'],
    ['b', 'needs'],
  ]);
  const now = [session('a', 'x', 'needs'), session('b', 'y', 'needs'), session('c', 'z', 'needs')];
  assert.deepEqual(
    newlyNeeding(before, now).map((s) => s.id),
    ['a', 'c'],
  );
});

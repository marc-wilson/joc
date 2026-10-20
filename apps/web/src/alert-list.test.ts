import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Alert, GitHubNotification } from '@joc/protocol';
import { alertRow, pageTitle, settle, toastable, toastText, waitingCount } from './alert-list.ts';

const alert = (id: string, extra: Partial<Alert> = {}): Alert => ({
  id,
  kind: 'needs',
  title: `Session ${id}`,
  repo: 'harbor-labs/atlas-web',
  sessionId: `s${id}`,
  at: '2026-10-18T10:00:00.000Z',
  read: false,
  ...extra,
});

const review = (id: string, number: number, extra: Partial<Alert> = {}) =>
  alert(id, {
    kind: 'review',
    title: 'Fix the auth redirect',
    sessionId: undefined,
    number,
    url: `https://github.com/harbor-labs/atlas-web/pull/${number}`,
    detail: 'mira-okafor',
    ...extra,
  });

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

test("an alert's row: a session opens here, a review on GitHub", () => {
  assert.deepEqual(alertRow(alert('1', { detail: 'Permission: `rm -rf dist`' })), {
    mark: 'needs',
    href: '/?session=s1',
    external: false,
    reference: 'atlas-web',
    verb: 'Needed you: Permission: rm -rf dist',
  });
  assert.equal(alertRow(alert('2', { kind: 'finished' })).verb, 'Finished');
  assert.deepEqual(alertRow(review('3', 42)), {
    mark: 'review',
    href: 'https://github.com/harbor-labs/atlas-web/pull/42',
    external: true,
    reference: 'atlas-web#42',
    verb: 'Review requested · opened by mira-okafor',
  });
});

test('the list holds still: rows update in place, cleared ones leave, new ones wait', () => {
  const first = settle(undefined, [alert('2'), alert('1')]);
  assert.deepEqual(
    first.shown.map((a) => a.id),
    ['2', '1'],
  );
  assert.deepEqual(first.fresh, []);
  const next = settle(first.shown, [alert('3'), alert('2', { read: true })]);
  assert.deepEqual(
    next.shown.map((a) => [a.id, a.read]),
    [['2', true]],
  );
  assert.deepEqual(
    next.fresh.map((a) => a.id),
    ['3'],
  );
});

test('what waits on you: sessions needing you, reviews and GitHub alerts, a review once', () => {
  const alerts = [
    alert('1'),
    alert('2', { read: true }),
    alert('3', { kind: 'finished' }),
    review('4', 42),
  ];
  const threads = [
    thread('42', { reason: 'review_requested', alert: 'review' }),
    thread('43', { reason: 'mention', alert: 'mention' }),
    thread('44'),
  ];
  // Two sessions need you; the review counts once with its thread; the mention counts.
  assert.equal(waitingCount(2, alerts, threads), 4);
  assert.equal(waitingCount(0, [], []), 0);
  assert.equal(pageTitle(0), 'JOC');
  assert.equal(pageTitle(3), '(3) JOC');
});

test("toasts: only news, and not the session you're looking at", () => {
  const seen = new Set(['1']);
  const list = [
    alert('1'),
    alert('2', { sessionId: 'on-screen' }),
    alert('3', { kind: 'finished' }),
    alert('4', { read: true }),
    review('5', 7),
    alert('6'),
  ];
  assert.deepEqual(
    toastable(seen, list, 'on-screen').map((a) => a.id),
    ['5', '6'],
  );
  // Each is news once.
  assert.deepEqual(toastable(seen, list, 'on-screen'), []);
});

test("a toast's words", () => {
  assert.deepEqual(toastText(alert('1', { detail: 'Waiting for you' })), {
    title: 'Needs you',
    body: 'Session 1: Waiting for you',
    action: 'Open session',
  });
  assert.deepEqual(toastText(review('2', 42)), {
    title: 'Review requested',
    body: 'atlas-web#42 Fix the auth redirect',
    action: 'Open on GitHub',
  });
});

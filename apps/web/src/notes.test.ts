import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type Alert,
  applyPrefsPatch,
  DEFAULT_PREFS,
  type GitHubNotification,
  type Session,
} from '@joc/protocol';
import {
  allNotes,
  arrived,
  bellCounts,
  ciPrompt,
  groupNotes,
  hold,
  inTab,
  type Note,
  pageTitle,
  panelNotes,
} from './notes.ts';

const session = (id: string, extra: Partial<Session> = {}): Session =>
  ({
    id,
    repo: 'harbor-labs/atlas-web',
    state: 'needs',
    title: `Session ${id}`,
    updatedAt: '2026-10-18T10:05:00.000Z',
    ...extra,
  }) as Session;

const alert = (id: string, extra: Partial<Alert> = {}): Alert => ({
  id,
  kind: 'finished',
  title: `Session ${id}`,
  repo: 'harbor-labs/atlas-web',
  sessionId: `s${id}`,
  at: '2026-10-18T10:00:00.000Z',
  read: false,
  ...extra,
});

const thread = (id: string, extra: Partial<GitHubNotification> = {}): GitHubNotification => ({
  id,
  reason: 'comment',
  title: 'Fix the auth redirect',
  type: 'PullRequest',
  repo: 'harbor-labs/atlas-web',
  url: `https://github.com/harbor-labs/atlas-web/pull/${id}`,
  updatedAt: '2026-10-18T09:00:00.000Z',
  number: Number(id),
  ...extra,
});

test('a session waiting on you is a question or a permission, pinned first and always unread', () => {
  const notes = allNotes(
    [
      session('a', { activity: 'Permission: pnpm prisma migrate reset' }),
      session('b', { activity: 'Which sender domain should I use?' }),
      session('c', { state: 'working' }),
    ],
    [alert('1')],
    [],
  );
  assert.deepEqual(
    notes.map((n) => [n.kind, n.title, n.text, n.live]),
    [
      ['permission', 'Session a wants permission', 'pnpm prisma migrate reset', true],
      ['question', 'Session b needs you', 'Which sender domain should I use?', true],
      ['finished', 'Session 1 finished a turn', undefined, undefined],
    ],
  );
  assert.deepEqual(bellCounts(notes), { needs: 2, unread: 3 });
  assert.equal(pageTitle(2), '(2) JOC');
  assert.equal(pageTitle(0), 'JOC');
});

test('a waiting session keeps the time it started waiting, not its latest report', () => {
  const [note] = allNotes(
    [session('a')],
    [alert('1', { kind: 'needs', sessionId: 'a', at: '2026-10-18T10:01:00.000Z' })],
    [],
  );
  assert.equal(note?.at, '2026-10-18T10:01:00.000Z');
});

test('a needs alert is a record for the history only, once the session stopped waiting', () => {
  const needs = alert('1', { kind: 'needs', detail: 'Permission: Edit src/app.ts', read: true });
  assert.deepEqual(allNotes([], [needs], []), []);
  const waitingAgain = alert('2', { kind: 'needs', sessionId: 'a' });
  assert.deepEqual(
    allNotes([session('a')], [waitingAgain], [], true).map((n) => n.id),
    ['session:a'],
  );
  const [record] = allNotes([], [needs], [], true);
  assert.deepEqual(
    [record?.title, record?.text, record?.unread],
    ['Session 1 wanted permission', 'Edit src/app.ts', false],
  );
});

test('a review requested both ways is one note that marks both read', () => {
  const notes = allNotes(
    [],
    [alert('1', { kind: 'review', sessionId: undefined, number: 7, read: true, detail: 'mira' })],
    [thread('7', { reason: 'review_requested' }), thread('8', { reason: 'mention' })],
  );
  assert.deepEqual(
    notes.map((n) => [n.kind, n.title, n.threadIds, n.unread]),
    [
      ['review', 'Review requested on #7', ['7'], true],
      ['mention', 'You were mentioned on #8', ['8'], true],
    ],
  );
  assert.deepEqual(
    groupNotes(notes).map(([g, list]) => [g, list.length]),
    [['reviews', 2]],
  );
});

test('failed CI is activity on the GitHub tab, and its prompt names the run', () => {
  const [ci] = allNotes(
    [],
    [],
    [
      thread('9', {
        reason: 'ci_activity',
        alert: 'ci-failed',
        type: 'CheckSuite',
        number: undefined,
        branch: 'fix/auth',
      }),
    ],
  );
  assert.deepEqual(
    [ci?.kind, ci?.group, ci?.title],
    ['ci-failed', 'activity', 'CI failed on fix/auth'],
  );
  assert.equal(ci && inTab(ci, 'github'), true);
  assert.equal(ci && inTab(ci, 'needs'), false);
  assert.match(ciPrompt(ci as Note), /^CI failed on fix\/auth: https:\/\/github.com\//);
});

test('the panel leaves out kinds the person turned off there, but never a waiting session', () => {
  const off = { panel: false, toast: false, desktop: false };
  const prefs = applyPrefsPatch(
    DEFAULT_PREFS,
    { notificationKinds: { mention: off, question: off } },
    1,
  );
  const notes = allNotes([session('a')], [], [thread('8', { reason: 'mention' })]);
  assert.deepEqual(
    panelNotes(notes, prefs).map((n) => n.kind),
    ['question'],
  );
});

const note = (id: string, at: string, group: Note['group'] = 'activity'): Note => ({
  id,
  kind: 'finished',
  group,
  github: false,
  lead: { state: 'idle' },
  title: id,
  source: 'atlas-web',
  at,
  unread: true,
  href: '/',
  external: false,
  repo: 'harbor-labs/atlas-web',
  threadIds: [],
});

test('while you read, arrivals wait and a cleared row keeps its space', () => {
  const a = note('a', '2026-10-18T10:00:00.000Z');
  const b = note('b', '2026-10-18T11:00:00.000Z');
  const c = note('c', '2026-10-18T12:00:00.000Z');
  const n = note('n', '2026-10-18T09:00:00.000Z', 'needs');
  const first = hold(undefined, [a, b, n], { arrivals: false, slots: false });
  assert.deepEqual(first.ids, ['n', 'b', 'a']);

  // Pointer in the list: c waits, and b, cleared, stays a blank slot.
  const reading = hold(first, [a, c, n], { arrivals: true, slots: true });
  assert.deepEqual(reading, { ids: ['n', 'b', 'a'], waiting: ['c'] });

  // Pointer gone: everything takes its place, newest first in its group.
  assert.deepEqual(hold(reading, [a, c, n], { arrivals: false, slots: false }), {
    ids: ['n', 'c', 'a'],
    waiting: [],
  });
});

test('a toast is for news since last time, unread, and not the session on screen', () => {
  const notes = allNotes([session('a'), session('b')], [alert('1', { read: true })], []);
  assert.deepEqual(
    arrived(new Set(['session:b']), notes, 'x').map((n) => n.id),
    ['session:a'],
  );
  assert.deepEqual(
    arrived(new Set(), notes, 'a').map((n) => n.id),
    ['session:b'],
  );
});

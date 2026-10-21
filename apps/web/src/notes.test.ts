import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type Alert,
  applyPrefsPatch,
  DEFAULT_PREFS,
  type GitHubNotification,
  type GitHubSnapshot,
  type PullRequest,
  type Session,
} from '@joc/protocol';
import {
  allNotes,
  arrived,
  attention,
  bellCounts,
  clearable,
  groupNotes,
  hold,
  inTab,
  type Note,
  type NoteSources,
  pageTitle,
  panelNotes,
  withLeaving,
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
  kind: 'long-turn',
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

const pr = (number: number, extra: Partial<PullRequest> = {}): PullRequest => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/harbor-labs/atlas-web/pull/${number}`,
  repo: 'harbor-labs/atlas-web',
  branch: `fix/${number}`,
  author: 'mira',
  updatedAt: '2026-10-18T08:00:00.000Z',
  draft: false,
  additions: 1,
  deletions: 1,
  ci: 'pass',
  ...extra,
});

const github = (
  updatedAt: string,
  reviewRequested: PullRequest[] = [],
  mine: PullRequest[] = [],
): GitHubSnapshot => ({ state: 'reported', status: 'ok', reviewRequested, mine, updatedAt });

const notesOf = (src: Partial<NoteSources>) =>
  allNotes({ sessions: [], alerts: [], threads: [], ...src });

const LATER = '2026-10-18T11:00:00.000Z';
const EARLIER = '2026-10-18T08:30:00.000Z';
const LONG_ON = applyPrefsPatch(
  DEFAULT_PREFS,
  {
    notificationKinds: { 'long-turn': { panel: true, toast: false, desktop: false, sound: false } },
  },
  1,
);

test('a session waiting on you is a question or a permission, pinned first and always unread', () => {
  const notes = notesOf({
    sessions: [
      session('a', { activity: 'Permission: pnpm prisma migrate reset' }),
      session('b', { activity: 'Which sender domain should I use?' }),
      session('c', { state: 'working' }),
    ],
    alerts: [alert('1')],
  });
  assert.deepEqual(
    notes.map((n) => [n.kind, n.title, n.text, n.live]),
    [
      ['permission', 'Session a wants permission', 'pnpm prisma migrate reset', true],
      ['question', 'Session b needs you', 'Which sender domain should I use?', true],
      ['long-turn', 'Session 1 finished', undefined, undefined],
    ],
  );
  assert.deepEqual(bellCounts(panelNotes(notes, LONG_ON)), { needs: 2, unread: 3 });
  assert.equal(pageTitle(2), '(2) JOC');
  assert.equal(pageTitle(0), 'JOC');
});

test('what notifies: needs you, reviews, mentions, failed CI; a long turn only when chosen', () => {
  const notes = notesOf({
    sessions: [session('a')],
    alerts: [
      alert('1'),
      alert('2', { kind: 'needs', sessionId: 'gone', read: true }),
      alert('3', { kind: 'review', sessionId: undefined, number: 7 }),
      alert('4', { kind: 'ci-failed', sessionId: undefined, number: 9, branch: 'fix/9' }),
    ],
    threads: [
      thread('8', { reason: 'mention' }),
      thread('10', { reason: 'author' }),
      thread('11', { reason: 'subscribed' }),
      thread('12', { reason: 'assign', type: 'Issue' }),
    ],
    records: true,
  });
  assert.deepEqual(
    panelNotes(notes, DEFAULT_PREFS).map((n) => [n.kind, n.title]),
    [
      ['question', 'Session a needs you'],
      ['review', 'Review requested on #7'],
      ['ci-failed', 'CI failed on #9'],
      ['mention', 'You were mentioned on #8'],
      ['mention', 'New activity on your #10'],
    ],
  );
  // The rest is kept to look back on: a long turn (off by default), a session that waited,
  // other GitHub activity.
  assert.deepEqual(
    notes.filter((n) => !panelNotes(notes, DEFAULT_PREFS).includes(n)).map((n) => n.id),
    ['alert:1', 'alert:2', 'github:11', 'github:12'],
  );
  assert.ok(panelNotes(notes, LONG_ON).some((n) => n.id === 'alert:1'));
});

test('opening a review or failed CI goes to the pull request in JOC, a mention to GitHub', () => {
  const [review, ci, mention] = notesOf({
    alerts: [
      alert('3', { kind: 'review', sessionId: undefined, number: 7, at: LATER }),
      alert('4', { kind: 'ci-failed', sessionId: undefined, number: 9 }),
    ],
    threads: [thread('8', { reason: 'mention' })],
  });
  assert.deepEqual(
    [review?.href, review?.external],
    ['/pr?repo=harbor-labs%2Fatlas-web&number=7', false],
  );
  assert.deepEqual([ci?.href, ci?.external], ['/pr?repo=harbor-labs%2Fatlas-web&number=9', false]);
  assert.deepEqual(
    [mention?.href, mention?.external],
    ['https://github.com/harbor-labs/atlas-web/pull/8', true],
  );
});

test('a waiting session keeps the time it started waiting, not its latest report', () => {
  const [note] = notesOf({
    sessions: [session('a')],
    alerts: [alert('1', { kind: 'needs', sessionId: 'a', at: '2026-10-18T10:01:00.000Z' })],
  });
  assert.equal(note?.at, '2026-10-18T10:01:00.000Z');
});

test('a needs alert is a record for the history only, once the session stopped waiting', () => {
  const needs = alert('1', { kind: 'needs', detail: 'Permission: Edit src/app.ts', read: true });
  assert.deepEqual(notesOf({ alerts: [needs] }), []);
  const waitingAgain = alert('2', { kind: 'needs', sessionId: 'a' });
  assert.deepEqual(
    notesOf({ sessions: [session('a')], alerts: [waitingAgain], records: true }).map((n) => n.id),
    ['session:a'],
  );
  const [record] = notesOf({ alerts: [needs], records: true });
  assert.deepEqual(
    [record?.title, record?.text, record?.unread, record?.historyOnly],
    ['Session 1 wanted permission', 'Edit src/app.ts', false, true],
  );
});

test('a review requested both ways is one note that reads both', () => {
  const notes = notesOf({
    alerts: [alert('1', { kind: 'review', sessionId: undefined, number: 7, read: true })],
    threads: [thread('7', { reason: 'review_requested' }), thread('8', { reason: 'mention' })],
  });
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

test('threads read here leave the panel, a review asked both ways too', () => {
  const notes = notesOf({
    alerts: [alert('1', { kind: 'review', sessionId: undefined, number: 7, read: true })],
    threads: [thread('7', { reason: 'review_requested' }), thread('8', { reason: 'mention' })],
    read: new Set(['7', '8']),
  });
  assert.deepEqual(
    notes.map((n) => [n.threadIds, n.unread]),
    [
      [['7'], false],
      [['8'], false],
    ],
  );
  assert.deepEqual(panelNotes(notes, DEFAULT_PREFS), []);
});

test('a review request resolves once the pull request leaves your review-requested list', () => {
  const review = alert('1', { kind: 'review', sessionId: undefined, number: 7, at: EARLIER });
  const asked = thread('7', { reason: 'review_requested', updatedAt: LATER });
  const still = github(LATER, [pr(7)]);
  const reviewed = github(LATER, []);
  // Still asked, or no good read yet: it stays.
  for (const gh of [still, undefined, { ...reviewed, status: 'error' as const }]) {
    const [note] = notesOf({ alerts: [review], threads: [asked], github: gh });
    assert.equal(note?.unread, true);
  }
  // You posted your review (or the request was withdrawn, or it closed): gone from the panel,
  // kept in the history.
  const [done] = notesOf({ alerts: [review], threads: [asked], github: reviewed });
  assert.deepEqual([done?.resolved, done?.unread], [true, false]);
  assert.deepEqual(panelNotes([done as Note], DEFAULT_PREFS), []);
  // A thread alone resolves on the list, however late GitHub touched it.
  const [lone] = notesOf({ threads: [asked], github: github(EARLIER, []) });
  assert.equal(lone?.resolved, true);
  // An alert raised after the read: the read can't have seen it yet.
  const [fresh] = notesOf({ alerts: [{ ...review, at: LATER }], github: github(EARLIER, []) });
  assert.equal(fresh?.unread, true);
});

test('failed CI resolves once a later read finds it passing, or the pull request closed', () => {
  const failed = alert('4', {
    kind: 'ci-failed',
    sessionId: undefined,
    number: 9,
    branch: 'fix/9',
    at: EARLIER,
  });
  const run = thread('20', {
    reason: 'ci_activity',
    alert: 'ci-failed',
    type: 'CheckSuite',
    number: undefined,
    branch: 'fix/9',
    updatedAt: EARLIER,
  });
  const at = (gh?: GitHubSnapshot) => notesOf({ alerts: [failed], threads: [run], github: gh });
  // The run's thread twins with the alert: one note.
  assert.deepEqual(
    at().map((n) => [n.id, n.threadIds]),
    [['alert:4', ['20']]],
  );
  assert.equal(at(github(LATER, [], [pr(9, { ci: 'fail' })]))[0]?.unread, true);
  assert.equal(at(github(LATER, [], [pr(9, { ci: 'pass' })]))[0]?.resolved, true);
  assert.equal(at(github(LATER, [], [pr(9, { ci: 'pending' })]))[0]?.resolved, true);
  assert.equal(at(github(LATER, [], []))[0]?.resolved, true);
  // A read from before it failed says nothing about it.
  assert.equal(at(github('2026-10-18T08:00:00.000Z', [], [pr(9)]))[0]?.unread, true);
  // A run on a branch with no pull request waits to be opened.
  const [branchOnly] = notesOf({
    threads: [{ ...run, branch: 'spike/x' }],
    github: github(LATER, [], [pr(9)]),
  });
  assert.deepEqual(
    [branchOnly?.title, branchOnly?.unread, inTab(branchOnly as Note, 'github')],
    ['CI failed on spike/x', true, true],
  );
});

test('the panel leaves out kinds the person turned off there, but never a waiting session', () => {
  const off = { panel: false, toast: false, desktop: false, sound: false };
  const prefs = applyPrefsPatch(
    DEFAULT_PREFS,
    { notificationKinds: { mention: off, question: off } },
    1,
  );
  const notes = notesOf({
    sessions: [session('a')],
    threads: [thread('8', { reason: 'mention' })],
  });
  assert.deepEqual(
    panelNotes(notes, prefs).map((n) => n.kind),
    ['question'],
  );
});

test('Clear all takes everything but the sessions waiting on you', () => {
  const notes = notesOf({
    sessions: [session('a')],
    threads: [thread('8', { reason: 'mention' }), thread('9', { reason: 'mention' })],
    read: new Set(['9']),
  });
  assert.deepEqual(
    clearable(notes).map((n) => n.id),
    ['github:8'],
  );
});

const note = (id: string, at: string, group: Note['group'] = 'activity'): Note => ({
  id,
  kind: 'mention',
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

test('while you read, arrivals wait; a row that went leaves at once', () => {
  const a = note('a', '2026-10-18T10:00:00.000Z');
  const b = note('b', '2026-10-18T11:00:00.000Z');
  const c = note('c', '2026-10-18T12:00:00.000Z');
  const n = note('n', '2026-10-18T09:00:00.000Z', 'needs');
  const first = hold(undefined, [a, b, n], false);
  assert.deepEqual(first.ids, ['n', 'b', 'a']);

  // Pointer in the list: c waits behind the pill, and b, dismissed, is gone at once.
  const reading = hold(first, [a, c, n], true);
  assert.deepEqual(reading, { ids: ['n', 'a'], waiting: ['c'] });

  // Pointer gone: everything takes its place, newest first in its group.
  assert.deepEqual(hold(reading, [a, c, n], false), { ids: ['n', 'c', 'a'], waiting: [] });
});

test('a leaving row fades where it was, then goes', () => {
  assert.deepEqual(withLeaving(['n', 'b', 'a'], ['n', 'a'], new Set(['b'])), ['n', 'b', 'a']);
  assert.deepEqual(withLeaving(['b', 'a'], ['a'], new Set(['b'])), ['b', 'a']);
  assert.deepEqual(withLeaving(['x', 'y', 'z'], [], new Set(['x', 'y', 'z'])), ['x', 'y', 'z']);
  assert.deepEqual(withLeaving(['n', 'a'], ['n', 'a'], new Set()), ['n', 'a']);
});

test('news is what arrived since, still needs you, and not the session on screen', () => {
  const notes = notesOf({
    sessions: [session('a'), session('b')],
    alerts: [alert('1', { read: true })],
    threads: [thread('11', { reason: 'subscribed' })],
  });
  assert.deepEqual(
    arrived(new Set(['session:b']), notes, 'x').map((n) => n.id),
    ['session:a'],
  );
  assert.deepEqual(
    arrived(new Set(), notes, 'a').map((n) => n.id),
    ['session:b'],
  );
});

test('by default a toast and a chime for needs you and review requests only', () => {
  const notes = notesOf({
    sessions: [session('a')],
    alerts: [
      alert('3', { kind: 'review', sessionId: undefined, number: 7 }),
      alert('4', { kind: 'ci-failed', sessionId: undefined, number: 9 }),
    ],
    threads: [thread('8', { reason: 'mention' })],
  });
  const byKind = (kind: string) => notes.filter((n) => n.kind === kind);
  const all = attention(notes, DEFAULT_PREFS);
  assert.deepEqual(
    all.toasts.map((n) => n.kind),
    ['question', 'review'],
  );
  assert.equal(all.chime, true);
  assert.equal(attention(byKind('review'), DEFAULT_PREFS).chime, true);
  assert.equal(
    attention([...byKind('mention'), ...byKind('ci-failed')], DEFAULT_PREFS).chime,
    false,
  );
  const quiet = applyPrefsPatch(DEFAULT_PREFS, { notificationSound: false }, 1);
  assert.equal(attention(notes, quiet).chime, false);
});

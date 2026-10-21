import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type Alert,
  applyPrefsPatch,
  DEFAULT_PREFS,
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

/** A comment from GitHub's webhooks: a mention, or one on your pull request. */
const comment = (id: string, extra: Partial<Alert> = {}): Alert =>
  alert(id, {
    kind: 'mention',
    sessionId: undefined,
    title: 'Fix the auth redirect',
    detail: 'mira',
    number: Number(id),
    url: `https://github.com/harbor-labs/atlas-web/pull/${id}#issuecomment-${id}01`,
    at: '2026-10-18T09:00:00.000Z',
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

const notesOf = (src: Partial<NoteSources>) => allNotes({ sessions: [], alerts: [], ...src });

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
    notes.map((n) => [n.kind, n.title, n.meta, n.code, n.live]),
    [
      ['permission', 'Session a needs permission', 'atlas-web', 'pnpm prisma migrate reset', true],
      [
        'question',
        'Session b has a question',
        'atlas-web · answer in Claude Code',
        undefined,
        true,
      ],
      ['long-turn', 'Session 1 finished', 'atlas-web', undefined, undefined],
    ],
  );
  // A plugin from before answers from JOC: nothing to answer inline.
  assert.deepEqual(
    notes.map((n) => n.answer),
    [undefined, undefined, undefined],
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
      comment('8'),
      comment('10', { kind: 'comment' }),
    ],
    records: true,
  });
  assert.deepEqual(
    panelNotes(notes, DEFAULT_PREFS).map((n) => [n.kind, n.title, n.meta]),
    [
      ['question', 'Session a has a question', 'atlas-web · answer in Claude Code'],
      ['review', 'Review requested on #7', 'Session 3 · atlas-web'],
      ['ci-failed', 'CI failed on #9', 'Session 4 · atlas-web'],
      ['mention', 'You were mentioned on #8', 'mira · Fix the auth redirect · atlas-web'],
      ['mention', 'New comment on #10', 'mira · Fix the auth redirect · atlas-web'],
    ],
  );
  // The rest is kept to look back on: a long turn (off by default), a session that waited.
  assert.deepEqual(
    notes.filter((n) => !panelNotes(notes, DEFAULT_PREFS).includes(n)).map((n) => n.id),
    ['alert:1', 'alert:2'],
  );
  assert.ok(panelNotes(notes, LONG_ON).some((n) => n.id === 'alert:1'));
});

test('opening a review or failed CI goes to the pull request in JOC, a mention to GitHub', () => {
  const [review, ci, mention] = notesOf({
    alerts: [
      alert('3', { kind: 'review', sessionId: undefined, number: 7, at: LATER }),
      alert('4', { kind: 'ci-failed', sessionId: undefined, number: 9 }),
      comment('8'),
    ],
  });
  assert.deepEqual(
    [review?.href, review?.external],
    ['/pr?repo=harbor-labs%2Fatlas-web&number=7', false],
  );
  assert.deepEqual([ci?.href, ci?.external], ['/pr?repo=harbor-labs%2Fatlas-web&number=9', false]);
  assert.deepEqual(
    [mention?.href, mention?.external],
    ['https://github.com/harbor-labs/atlas-web/pull/8#issuecomment-801', true],
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
    [record?.title, record?.code, record?.unread, record?.historyOnly],
    ['Session 1 wanted permission', 'Edit src/app.ts', false, true],
  );
});

test('reviews and comments are activity, under needs you', () => {
  const notes = notesOf({
    alerts: [alert('1', { kind: 'review', sessionId: undefined, number: 7 }), comment('8')],
  });
  assert.deepEqual(
    groupNotes(notes).map(([g, list]) => [g, list.length]),
    [['activity', 2]],
  );
});

test('a review request resolves once the pull request leaves your review-requested list', () => {
  const review = alert('1', { kind: 'review', sessionId: undefined, number: 7, at: EARLIER });
  const still = github(LATER, [pr(7)]);
  const reviewed = github(LATER, []);
  // Still asked, or no good read yet: it stays.
  for (const gh of [still, undefined, { ...reviewed, status: 'error' as const }]) {
    const [note] = notesOf({ alerts: [review], github: gh });
    assert.equal(note?.unread, true);
  }
  // You posted your review (or the request was withdrawn, or it closed): gone from the panel,
  // kept in the history.
  const [done] = notesOf({ alerts: [review], github: reviewed });
  assert.deepEqual([done?.resolved, done?.unread], [true, false]);
  assert.deepEqual(panelNotes([done as Note], DEFAULT_PREFS), []);
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
  const at = (gh?: GitHubSnapshot) => notesOf({ alerts: [failed], github: gh });
  assert.equal(at(github(LATER, [], [pr(9, { ci: 'fail' })]))[0]?.unread, true);
  assert.equal(at(github(LATER, [], [pr(9, { ci: 'pass' })]))[0]?.resolved, true);
  assert.equal(at(github(LATER, [], [pr(9, { ci: 'pending' })]))[0]?.resolved, true);
  assert.equal(at(github(LATER, [], []))[0]?.resolved, true);
  // A read from before it failed says nothing about it.
  assert.equal(at(github('2026-10-18T08:00:00.000Z', [], [pr(9)]))[0]?.unread, true);
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
    alerts: [comment('8')],
  });
  assert.deepEqual(
    panelNotes(notes, prefs).map((n) => n.kind),
    ['question'],
  );
});

test('Clear all takes everything but the sessions waiting on you', () => {
  const notes = notesOf({
    sessions: [session('a')],
    alerts: [comment('8'), comment('9', { read: true })],
  });
  assert.deepEqual(
    clearable(notes).map((n) => n.id),
    ['alert:8'],
  );
});

const note = (id: string, at: string, group: Note['group'] = 'activity'): Note => ({
  id,
  kind: 'mention',
  group,
  lead: { state: 'idle' },
  title: id,
  meta: 'atlas-web',
  source: 'atlas-web',
  at,
  unread: true,
  href: '/',
  external: false,
  repo: 'harbor-labs/atlas-web',
});

test('while you read, arrivals wait; a row that went leaves at once', () => {
  const a = note('a', '2026-10-18T10:00:00.000Z');
  const b = note('b', '2026-10-18T11:00:00.000Z');
  const c = note('c', '2026-10-18T12:00:00.000Z');
  const n = note('n', '2026-10-18T09:00:00.000Z', 'needs');
  const first = hold(undefined, [a, b, n], false);
  assert.deepEqual(first.ids, ['n', 'b', 'a']);

  // The panel open: c waits behind the new-items bar, and b, dismissed, is gone at once.
  const reading = hold(first, [a, c, n], true);
  assert.deepEqual(reading, { ids: ['n', 'a'], waiting: ['c'] });

  // Shown: everything takes its place, newest first in its group.
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

test('by default a toast for needs you and review requests, a chime for needs you only', () => {
  const notes = notesOf({
    sessions: [session('a')],
    alerts: [
      alert('3', { kind: 'review', sessionId: undefined, number: 7 }),
      alert('4', { kind: 'ci-failed', sessionId: undefined, number: 9 }),
      comment('8'),
    ],
  });
  const byKind = (kind: string) => notes.filter((n) => n.kind === kind);
  const all = attention(notes, DEFAULT_PREFS);
  assert.deepEqual(
    all.toasts.map((n) => n.kind),
    ['question', 'review'],
  );
  assert.equal(all.chime, true);
  assert.equal(attention(byKind('review'), DEFAULT_PREFS).chime, false);
  assert.equal(
    attention([...byKind('mention'), ...byKind('ci-failed')], DEFAULT_PREFS).chime,
    false,
  );
  const quiet = applyPrefsPatch(DEFAULT_PREFS, { notificationSound: false }, 1);
  assert.equal(attention(notes, quiet).chime, false);
});

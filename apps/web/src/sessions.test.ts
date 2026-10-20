import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Session, SessionSort } from '@joc/protocol';
import { arrangeGroups, groupSessions, PINNED_GROUP, REVIEWS_GROUP } from './sessions.ts';
import { toggled } from './toggled.ts';

const session = (id: string, repo: string): Session => ({
  id,
  repo,
  state: 'idle',
  startedAt: '2026-10-18T09:00:00.000Z',
  updatedAt: '2026-10-18T09:00:00.000Z',
});

const web = 'harbor-labs/atlas-web';
const api = 'harbor-labs/atlas-api';
const list = [session('a', web), session('b', api), session('c', web)];
const shape = (pinned: string[]) =>
  groupSessions(list, pinned).map((g) => [g.label, g.sessions.map((s) => s.id)]);

test('sessions group by repo, A to Z', () => {
  assert.deepEqual(shape([]), [
    [api, ['b']],
    [web, ['a', 'c']],
  ]);
});

test('pinned sessions come first, in the order pinned, and only there', () => {
  assert.deepEqual(shape(['c', 'b']), [
    ['Pinned', ['c', 'b']],
    [web, ['a']],
  ]);
});

test('a pin for a session that has gone shows nothing', () => {
  assert.deepEqual(shape(['gone']), shape([]));
});

test('toggling keeps the rest of the list in order', () => {
  assert.deepEqual(toggled(['a', 'b'], 'c', true), ['a', 'b', 'c']);
  assert.deepEqual(toggled(['a', 'b', 'c'], 'b', false), ['a', 'c']);
  assert.deepEqual(toggled(['a'], 'a', true), ['a']);
});

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 18, 9, minutes)).toISOString();
const live = (id: string, state: Session['state'], extra: Partial<Session> = {}): Session => ({
  ...session(id, web),
  state,
  startedAt: at(Number(id.slice(1))),
  ...extra,
});
const ids = (groups: ReturnType<typeof groupSessions>) =>
  groups.map((g) => [g.id, g.sessions.map((s) => s.id)]);

test('each sort orders the sessions within their group', () => {
  const list = [
    live('s1', 'idle', { title: 'Tidy graph', activeAt: at(30) }),
    live('s2', 'working', { title: 'Add pagination', activeAt: at(50) }),
    live('s3', 'needs', { title: 'Fix 10 specs', activeAt: at(40) }),
    live('s4', 'working', { title: 'Fix 9 specs', activeAt: at(55) }),
  ];
  const order = (sort: SessionSort) => ids(groupSessions(list, [], sort))[0]?.[1];
  // State, ties in first-seen order so two working sessions never swap as they work.
  assert.deepEqual(order('state'), ['s3', 's2', 's4', 's1']);
  assert.deepEqual(order('activity'), ['s4', 's2', 's3', 's1']);
  assert.deepEqual(order('name'), ['s2', 's4', 's3', 's1']);
  assert.deepEqual(order('seen'), ['s1', 's2', 's3', 's4']);
});

test('reviews have their own group, first, with finished ones after the live ones', () => {
  const review = { repo: web, number: 512 };
  const list = [
    live('s1', 'working'),
    live('s2', 'idle', { review, activeAt: at(20) }),
    live('s3', 'working', { review }),
    live('s4', 'offline', { review, activeAt: at(10) }),
    live('s5', 'needs', { review }),
  ];
  assert.deepEqual(ids(groupSessions(list, ['s1'], 'state')), [
    [REVIEWS_GROUP, ['s5', 's3', 's4', 's2']],
    [PINNED_GROUP, ['s1']],
  ]);
});

test('a held order keeps rows in place within their groups; new ones join the end', () => {
  const groups = groupSessions(
    [live('s1', 'needs'), live('s2', 'working'), session('n', api), live('s3', 'idle')],
    [],
    'state',
  );
  assert.deepEqual(ids(arrangeGroups(groups, ['s3', 's2', 's1'])), [
    [`repo:${api}`, ['n']],
    [`repo:${web}`, ['s3', 's2', 's1']],
  ]);
  assert.deepEqual(ids(arrangeGroups(groups, ['s2'])), [
    [`repo:${api}`, ['n']],
    [`repo:${web}`, ['s2', 's1', 's3']],
  ]);
});

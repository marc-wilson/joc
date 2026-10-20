import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Session } from '@joc/protocol';
import { groupSessions } from './sessions.ts';
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

test('sessions group by repo in first-seen order', () => {
  assert.deepEqual(shape([]), [
    [web, ['a', 'c']],
    [api, ['b']],
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

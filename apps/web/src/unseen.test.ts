import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConversationItem } from '@joc/protocol';
import { seenIds, unseenCount } from './unseen.ts';

const at = '2026-10-20T10:00:00.000Z';
const user = (id: string): ConversationItem => ({ id, at, kind: 'user', text: 'Fix the build' });
const claude = (id: string): ConversationItem => ({ id, at, kind: 'claude', text: 'Done.' });
const command = (id: string): ConversationItem => ({
  id,
  at,
  kind: 'command',
  name: 'compact',
  args: '',
});
const call = (id: string): ConversationItem => ({
  id,
  at,
  kind: 'tool_call',
  toolUseId: `t-${id}`,
  name: 'Bash',
  summary: 'pnpm test',
});
const result = (id: string): ConversationItem => ({
  id,
  at,
  kind: 'tool_result',
  toolUseId: `t-${id}`,
  isError: false,
  text: 'ok',
});

const before = [user('u1'), claude('c1')];

test('nothing is new while you are at the bottom', () => {
  assert.equal(unseenCount([...before, claude('c2')], undefined), 0);
});

test('nothing is new right after you scroll up', () => {
  assert.equal(unseenCount(before, seenIds(before)), 0);
});

test('counts the messages that arrived after you scrolled up', () => {
  const seen = seenIds(before);
  assert.equal(unseenCount([...before, claude('c2')], seen), 1);
  assert.equal(unseenCount([...before, claude('c2'), user('u2'), command('k1')], seen), 3);
});

test("Claude's tool calls and their results are not messages", () => {
  const seen = seenIds(before);
  const items = [...before, call('x1'), result('x1'), call('x2'), claude('c2')];
  assert.equal(unseenCount(items, seen), 1);
});

test('a message that replaced one you sent from here is not new', () => {
  const seen = seenIds(before);
  const items = [...before, user('u2'), claude('c2')];
  assert.equal(unseenCount(items, seen, new Set(['u2'])), 1);
});

test('messages already seen are not counted again, wherever they sit', () => {
  const seen = seenIds(before);
  assert.equal(unseenCount([claude('c1'), user('u1')], seen), 0);
});

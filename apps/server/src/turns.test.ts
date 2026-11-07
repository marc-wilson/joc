import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConversationItem } from '@joc/protocol';
import { turnNews } from './turns.ts';

const at = '2026-10-18T10:00:00.000Z';
const you = (text = 'Fix the login page'): ConversationItem => ({
  id: 'u',
  at,
  kind: 'user',
  text,
});
const claude = (text = 'Fixed.\n\nDetails follow.'): ConversationItem => ({
  id: 'c',
  at,
  kind: 'claude',
  text,
});
const relayed: ConversationItem = {
  id: 't',
  at,
  kind: 'user',
  text: 'Another Claude session sent a message:\n<teammate-message teammate_id="ci">Done.</teammate-message>',
};

test('a prompt with no answer yet is sent', () => {
  assert.deepEqual(turnNews([you()], 'working'), { words: undefined, sent: true, answered: false });
});

test('an answer mid-turn leaves the turn open', () => {
  assert.equal(turnNews([you(), claude()], 'working').sent, true);
});

test('an answer that lands after the turn ended is answered, not sent', () => {
  const news = turnNews([you(), claude()], 'background');
  assert.deepEqual(news, { words: 'Fixed.', sent: false, answered: true });
});

test('a teammate is not you', () => {
  const news = turnNews([relayed, claude('Nothing for you to do.')], 'background');
  assert.deepEqual(news, { words: 'Nothing for you to do.', sent: false, answered: false });
});

test("a subagent's steps say nothing about the session's turn", () => {
  const step: ConversationItem = { ...you(), task: 'a1' };
  assert.equal(turnNews([step], 'working').sent, false);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { teammateMessages } from './teammate.ts';

const NOTE = '\n\nThis came from another Claude session — not typed by your user.';
const relayed = (...messages: string[]) =>
  `Another Claude session sent a message:\n${messages.join('\n')}${NOTE}`;

test('a teammate message loses its wrapping and the note for Claude', () => {
  const text = relayed(
    '<teammate-message teammate_id="ci" color="blue" summary="Checks green">\nAll passing.\n</teammate-message>',
  );
  assert.deepEqual(teammateMessages(text), [
    { from: 'ci', summary: 'Checks green', text: 'All passing.' },
  ]);
});

test('signals between teammates leave nothing to show', () => {
  const signal = JSON.stringify({ type: 'idle_notification', from: 'ci', result: 'Waiting.' });
  const text = relayed(
    `<teammate-message teammate_id="ci" color="blue">\n${signal}\n</teammate-message>`,
  );
  assert.deepEqual(teammateMessages(text), []);
});

test('one entry can carry several, and signals drop out from among them', () => {
  const text = relayed(
    '<teammate-message teammate_id="ci">Done.</teammate-message>',
    '<teammate-message teammate_id="docs">{"type":"idle_notification"}</teammate-message>',
    '<teammate-message teammate_id="web">Blocked on #12.</teammate-message>',
  );
  assert.deepEqual(
    teammateMessages(text)?.map((m) => m.from),
    ['ci', 'web'],
  );
});

test('a message cut off before its closing tag still reads', () => {
  const text =
    'Another Claude session sent a message:\n<teammate-message teammate_id="ci">Long re…';
  assert.deepEqual(teammateMessages(text), [{ from: 'ci', summary: undefined, text: 'Long re…' }]);
});

test('JSON that is not a signal stays a message', () => {
  const text = relayed('<teammate-message teammate_id="ci">{"passed": 12}</teammate-message>');
  assert.equal(teammateMessages(text)?.[0]?.text, '{"passed": 12}');
});

test('a prompt that only mentions the tag is left alone', () => {
  assert.equal(
    teammateMessages('why does <teammate-message teammate_id="ci"> show up?'),
    undefined,
  );
  assert.equal(teammateMessages('Fix the login page'), undefined);
});

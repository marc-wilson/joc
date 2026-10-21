import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConversationItem, PromptStatus } from '@joc/protocol';
import { arrived, ordinal, type PendingPrompt, pendingViews, queueLine } from './pending.ts';

const at = '2026-10-18T10:00:00.000Z';
const image = { id: 'a'.repeat(64), type: 'image/png' } as const;
let next = 0;
const prompt = (text: string, extra: Partial<PendingPrompt> = {}): PendingPrompt => ({
  id: `p${++next}`,
  sessionId: 's1',
  text,
  images: [],
  serverId: `srv-${next}`,
  ...extra,
});
const user = (id: string, text: string, images?: (typeof image)[]): ConversationItem => ({
  id,
  at,
  kind: 'user',
  text,
  ...(images ? { images } : {}),
});
const status = (p: PendingPrompt, phase: PromptStatus['phase'], reason?: string): PromptStatus => ({
  id: p.serverId ?? '',
  phase,
  ...(reason ? { reason } : {}),
});

test('a prompt arrives once its text and images are in the conversation', () => {
  const items = [user('u1', 'Fix the login loop'), user('u2', 'Why is this red?', [image])];
  const plain = prompt('Fix the login loop');
  const pictured = prompt('Why is this red?', { images: [image] });
  // An earlier message with the same text but no image is not this one.
  const other = prompt('Fix the login loop', { images: [image] });
  const found = arrived(items, [plain, pictured, other]);
  assert.equal(found.get(plain.id), 'u1');
  assert.equal(found.get(pictured.id), 'u2');
  assert.equal(found.has(other.id), false);
});

test('a slash command arrives once the session has run it', () => {
  const items: ConversationItem[] = [
    { id: 'c1', at, kind: 'command', name: 'compact', args: 'keep the auth notes' },
  ];
  const found = arrived(items, [
    prompt('/compact   keep the auth notes'),
    prompt('/compact keep the auth notes', { images: [image] }),
  ]);
  assert.deepEqual([...found.values()], ['c1']);
});

test('an older message with the same text is not the transcript copy', () => {
  const items = [user('u1', 'yes'), user('c1', 'ok')];
  const again = prompt('yes', { after: 'c1' });
  assert.equal(arrived(items, [again]).size, 0);
  assert.equal(arrived([...items, user('u2', 'yes')], [again]).get(again.id), 'u2');
});

test('the same text sent twice waits for two copies, in order', () => {
  const first = prompt('run the tests', { after: 'c0' });
  const second = prompt('run the tests', { after: 'c0' });
  const items = [user('c0', 'hi'), user('u1', 'run the tests')];
  const once = arrived(items, [first, second]);
  assert.equal(once.get(first.id), 'u1');
  assert.equal(once.has(second.id), false);
  const twice = arrived([...items, user('u2', 'run the tests')], [first, second]);
  assert.equal(twice.get(second.id), 'u2');
});

test('a cancelled or failed prompt leaves its copy to the next one', () => {
  const failed = prompt('again', { failed: "the server couldn't be reached" });
  const retried = prompt('again');
  assert.equal(arrived([user('u1', 'again')], [failed, retried]).get(retried.id), 'u1');
});

test('a prompt is sending until the plugin takes it, and only then queued', () => {
  const p = prompt('Add a test');
  const notPosted = prompt('Still uploading', { serverId: undefined });
  const [unsaid, local] = pendingViews([p, notPosted], [], 'working');
  assert.equal(unsaid?.phase, 'sending');
  assert.equal(unsaid?.changeable, false, "can't change it before the server says it has it");
  assert.equal(local?.line, 'Sending…');

  const [waiting] = pendingViews([p], [status(p, 'waiting')], 'working');
  assert.deepEqual([waiting?.line, waiting?.changeable], ['Sending…', true]);

  const [claimed] = pendingViews([p], [status(p, 'claimed')], 'working');
  assert.deepEqual([claimed?.phase, claimed?.changeable], ['sending', false]);

  const [queued] = pendingViews([p], [status(p, 'queued')], 'working');
  assert.deepEqual(
    [queued?.phase, queued?.line, queued?.changeable, queued?.position],
    ['queued', 'Queued · Claude reads it when this turn ends', false, undefined],
  );
  // An idle session starts on it at once.
  assert.equal(pendingViews([p], [status(p, 'queued')], 'idle')[0]?.line, 'Sent to Claude Code');
});

test('several queued prompts show their place, in the order they were sent', () => {
  const a = prompt('one');
  const b = prompt('two');
  const c = prompt('three');
  const views = pendingViews(
    [a, b, c],
    [status(c, 'waiting'), status(b, 'queued'), status(a, 'queued')],
    'working',
  );
  assert.deepEqual(
    views.map((v) => v.line),
    [
      'Queued · 1st in queue · Claude reads it when this turn ends',
      'Queued · 2nd in queue · Claude reads it when this turn ends',
      'Sending…',
    ],
  );
  assert.equal(queueLine(views, 'working'), '3 messages queued for when Claude finishes');
  const handed = pendingViews([a, b], [status(a, 'queued'), status(b, 'queued')], 'working');
  assert.equal(
    queueLine(handed, 'working'),
    "2 messages queued for when Claude finishes · In Claude Code's queue, can't be changed from JOC",
  );
});

test('a prompt that failed says why; one held for an offline session can still change', () => {
  const lost = prompt('lost', { failed: "the server couldn't be reached" });
  const refused = prompt('refused');
  const held = prompt('held');
  const views = pendingViews(
    [lost, refused, held],
    [status(refused, 'failed', 'a hook dropped it'), status(held, 'waiting')],
    'offline',
  );
  assert.deepEqual(
    views.map((v) => [v.phase, v.line, v.changeable]),
    [
      ['failed', "Not delivered: the server couldn't be reached", false],
      ['failed', 'Not delivered: a hook dropped it', false],
      ['failed', "Not delivered: the session is offline. It's sent when the session is back", true],
    ],
  );
  assert.equal(queueLine(views, 'offline'), '1 message waiting for the session to come back');
  assert.equal(queueLine(views.slice(0, 2), 'working'), undefined);
});

test('ordinals', () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 103, 111].map(ordinal), [
    '1st',
    '2nd',
    '3rd',
    '4th',
    '11th',
    '12th',
    '13th',
    '21st',
    '22nd',
    '103rd',
    '111th',
  ]);
});

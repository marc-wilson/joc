import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_ANSWER_WAIT_MS, Waiting } from '@joc/protocol';
import {
  ANSWER_POLL_MS,
  answerOf,
  callSummary,
  decisionFor,
  inputKey,
  newWaitingId,
  waitingFor,
} from './waiting.ts';

const ask = {
  questions: [
    {
      question: 'Which sender domain should I use?',
      header: 'Domain',
      options: [
        { label: 'mail.atlas.dev', description: 'A subdomain for mail' },
        { label: 'atlas.dev', description: '' },
      ],
      multiSelect: false,
    },
  ],
};

test('a question waits as its questions, in the shape the server takes', () => {
  const waiting = waitingFor(newWaitingId(), 'AskUserQuestion', ask);
  assert.equal(Waiting.safeParse(waiting).success, true);
  assert.equal(waiting?.kind, 'question');
  if (waiting?.kind !== 'question') return;
  assert.deepEqual(waiting.questions[0]?.options, [
    { label: 'mail.atlas.dev', description: 'A subdomain for mail' },
    { label: 'atlas.dev' },
  ]);
  // Nothing to ask: only Claude Code can answer it.
  assert.equal(waitingFor('wait-0001', 'AskUserQuestion', { questions: [] }), undefined);
});

test('a permission request waits as its tool and what the call does', () => {
  const bash = waitingFor('wait-0002', 'Bash', {
    command: 'pnpm prisma migrate reset\n--force',
    description: 'Reset the database',
  });
  assert.deepEqual(bash, {
    kind: 'permission',
    id: 'wait-0002',
    tool: 'Bash',
    summary: 'pnpm prisma migrate reset',
    description: 'Reset the database',
  });
  assert.equal(Waiting.safeParse(bash).success, true);
  assert.equal(
    callSummary('Edit', { file_path: '/work/atlas-web/src/auth.ts' }, '/work/atlas-web'),
    'src/auth.ts',
  );
  assert.equal(
    callSummary('WebFetch', { url: 'https://atlas.dev/docs' }),
    'https://atlas.dev/docs',
  );
});

test('an answer from JOC becomes the call allowed once, or denied, never a rule', () => {
  const waiting = waitingFor('wait-0003', 'Bash', { command: 'ls' });
  assert.ok(waiting);
  assert.deepEqual(decisionFor(waiting, { kind: 'permission', allow: true }, { command: 'ls' }), {
    behavior: 'allow',
    updatedInput: { command: 'ls' },
  });
  const denied = decisionFor(waiting, { kind: 'permission', allow: false }, { command: 'ls' });
  assert.equal(denied?.behavior, 'deny');
  assert.equal(denied && 'updatedPermissions' in denied, false);
  // A question's answer doesn't answer a permission request.
  assert.equal(decisionFor(waiting, { kind: 'question', answers: {} }, {}), undefined);
});

test("a question's answer fills in the call's answers, and must answer every question", () => {
  const waiting = waitingFor('wait-0004', 'AskUserQuestion', ask);
  assert.ok(waiting);
  const answers = { 'Which sender domain should I use?': 'atlas.dev' };
  assert.deepEqual(decisionFor(waiting, { kind: 'question', answers }, ask), {
    behavior: 'allow',
    updatedInput: { ...ask, answers },
  });
  assert.equal(decisionFor(waiting, { kind: 'question', answers: { other: 'x' } }, ask), undefined);
});

test("a claim's reply is read without trusting it", () => {
  assert.deepEqual(answerOf({ answer: { kind: 'permission', allow: false } }), {
    kind: 'permission',
    allow: false,
  });
  assert.equal(answerOf({ answer: null }), undefined);
  assert.equal(answerOf({ answer: { kind: 'permission', allow: 'yes' } }), undefined);
  assert.deepEqual(answerOf({ answer: { kind: 'question', answers: { q: 'a', r: 3, s: ' ' } } }), {
    kind: 'question',
    answers: { q: 'a' },
  });
});

test('a call is keyed by its input whatever the order, and wait ids are fresh', () => {
  assert.equal(inputKey('Bash', { a: 1, b: [2] }), inputKey('Bash', { b: [2], a: 1 }));
  assert.notEqual(inputKey('Bash', { a: 1 }), inputKey('Edit', { a: 1 }));
  const id = newWaitingId();
  assert.match(id, /^[\w-]{8,64}$/);
  assert.notEqual(id, newWaitingId());
});

test('the answer poll asks the server to hold it no longer than it will', () => {
  assert.ok(ANSWER_POLL_MS <= MAX_ANSWER_WAIT_MS);
});

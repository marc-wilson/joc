import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Session, Waiting } from '@joc/protocol';
import {
  answerStatus,
  droppedAnswers,
  quickQuestion,
  type Sent,
  sendAnswer,
  waitingOf,
} from './answers.ts';
import { needsNotes } from './notes.ts';

const at = '2026-10-19T12:00:00.000Z';
const question: Waiting = {
  kind: 'question',
  id: 'wait-q1',
  questions: [
    {
      question: 'Which sender domain should I use?',
      options: [{ label: 'mail.atlas.dev' }, { label: 'atlas.dev' }],
      multiSelect: false,
    },
  ],
};
const permission: Waiting = {
  kind: 'permission',
  id: 'wait-p1',
  tool: 'Bash',
  summary: 'pnpm prisma migrate reset',
};
const session = (extra: Partial<Session> = {}): Session => ({
  id: 's1',
  title: 'Migrate mailer to Resend',
  repo: 'harbor-labs/atlas-web',
  state: 'needs',
  startedAt: at,
  updatedAt: at,
  ...extra,
});

/** A stand-in for apiFetch answering with `status` and `body`. */
const answering = (status: number, body?: unknown) => async () =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

test('a wait shows only while the session needs you', () => {
  assert.equal(waitingOf(session({ waiting: question }))?.id, 'wait-q1');
  assert.equal(waitingOf(session({ waiting: question, state: 'working' })), undefined);
});

test('a row answers in one press only a single, single-choice question with options', () => {
  assert.equal(quickQuestion(question)?.question, 'Which sender domain should I use?');
  assert.equal(quickQuestion(permission), undefined);
  const multi: Waiting = {
    ...question,
    questions: [{ question: 'Which?', options: [{ label: 'a' }], multiSelect: true }],
  };
  assert.equal(quickQuestion(multi), undefined);
  const words: Waiting = {
    ...question,
    questions: [{ question: 'What should it be called?', options: [], multiSelect: false }],
  };
  assert.equal(quickQuestion(words), undefined);
});

test('the status says who answered, and Claude Code winning beats a sent answer', () => {
  const waiting = session({ waiting: question });
  assert.equal(answerStatus('wait-q1', waiting), undefined);
  assert.equal(answerStatus('wait-q1', waiting, { state: 'sending' }), 'Sending…');
  const won = session({ answered: { id: 'wait-q1', by: 'claude-code' } });
  assert.equal(answerStatus('wait-q1', won, { state: 'sent' }), 'Answered in Claude Code');
  const ours = session({ answered: { id: 'wait-q1', by: 'joc' } });
  assert.equal(answerStatus('wait-q1', ours, { state: 'sent' }), 'Answered from JOC');
  // Another wait's record says nothing about this one.
  assert.equal(answerStatus('wait-q2', won), undefined);
});

test('an answer is sent once, and a refusal says who answered', async () => {
  let posts = 0;
  const post = async () => {
    posts++;
    return new Response(null, { status: 202 });
  };
  assert.deepEqual(await sendAnswer('s1', 'wait-once', { kind: 'permission', allow: true }, post), {
    state: 'sent',
  });
  await sendAnswer('s1', 'wait-once', { kind: 'permission', allow: false }, post);
  assert.equal(posts, 1);
  const late = await sendAnswer(
    's1',
    'wait-late',
    { kind: 'permission', allow: true },
    answering(409, { error: 'It was already answered', answeredBy: 'claude-code' }),
  );
  assert.deepEqual(late, { state: 'refused', by: 'claude-code' });
  const down = await sendAnswer(
    's1',
    'wait-down',
    { kind: 'permission', allow: true },
    async () => {
      throw new Error('offline');
    },
  );
  assert.deepEqual(down, { state: 'failed' });
});

test('an answer from JOC that Claude Code beat is said once', () => {
  const mine = new Map<string, Sent>([
    ['wait-q1', { state: 'sent' }],
    ['wait-p1', { state: 'sent' }],
    ['wait-x', { state: 'refused', by: 'claude-code' }],
  ]);
  const sessions = [
    session({ answered: { id: 'wait-q1', by: 'claude-code' } }),
    session({ id: 's2', answered: { id: 'wait-p1', by: 'joc' } }),
  ];
  assert.deepEqual(
    droppedAnswers(sessions, mine).map((d) => [d.waitingId, d.sessionId]),
    [
      ['wait-q1', 's1'],
      ['wait-x', undefined],
    ],
  );
});

test('a needs note carries the wait, and a command reads as one', () => {
  const [note] = needsNotes([session({ waiting: permission, activity: 'Permission: x' })]);
  assert.equal(note?.waiting?.id, 'wait-p1');
  assert.equal(note?.title, 'Migrate mailer to Resend wants to run a command');
  assert.equal(note?.text, 'pnpm prisma migrate reset');
  assert.equal(note?.mono, true);
});

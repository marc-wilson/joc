import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Session, Waiting } from '@joc/protocol';
import {
  answerStatus,
  droppedAnswers,
  inlineQuestion,
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

test('a needs note carries the wait: a permission answers inline beside its command', () => {
  const [note] = needsNotes([
    session({ waiting: permission, activity: 'Permission: x', branch: 'feat/resend' }),
  ]);
  assert.equal(note?.waiting?.id, 'wait-p1');
  assert.deepEqual(
    [note?.title, note?.meta, note?.answer, note?.command],
    [
      'Migrate mailer to Resend needs permission',
      'atlas-web · feat/resend',
      'permission',
      'pnpm prisma migrate reset',
    ],
  );
  assert.deepEqual(
    [note?.toastTitle, note?.text],
    ['Migrate mailer to Resend needs you', 'Claude wants to run pnpm prisma migrate reset'],
  );
});

test('a short single-choice question answers inline; anything else opens the session', () => {
  assert.equal(inlineQuestion(question)?.question, 'Which sender domain should I use?');
  const [quick] = needsNotes([session({ waiting: question })]);
  assert.deepEqual(
    [quick?.title, quick?.answer],
    ['Migrate mailer to Resend: Which sender domain should I use?', 'options'],
  );
  const three: Waiting = {
    ...question,
    questions: [
      {
        question: 'Which cache?',
        options: [{ label: 'Redis' }, { label: 'In-memory' }, { label: 'None' }],
        multiSelect: false,
      },
    ],
  };
  assert.equal(inlineQuestion(three), undefined);
  const long: Waiting = {
    ...question,
    questions: [
      {
        question: 'Which cache?',
        options: [{ label: 'Redis, behind the session store' }, { label: 'No' }],
        multiSelect: false,
      },
    ],
  };
  assert.equal(inlineQuestion(long), undefined);
  const [open] = needsNotes([session({ waiting: three })]);
  assert.deepEqual(
    [open?.title, open?.meta, open?.answer],
    [
      'Migrate mailer to Resend has a question',
      'atlas-web · 3 options · open to answer',
      undefined,
    ],
  );
});

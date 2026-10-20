import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Answer, answerFits, Session, type Waiting } from './index.ts';

const question: Waiting = {
  kind: 'question',
  id: 'wait-0001',
  questions: [
    {
      question: 'Which sender domain should I use?',
      header: 'Domain',
      options: [{ label: 'mail.atlas.dev' }, { label: 'atlas.dev' }],
      multiSelect: false,
    },
    { question: 'Keep the old sender too?', options: [], multiSelect: false },
  ],
};
const permission: Waiting = {
  kind: 'permission',
  id: 'wait-0002',
  tool: 'Bash',
  summary: 'pnpm prisma migrate reset',
};

test('an answer fits only the kind of wait it answers', () => {
  assert.equal(answerFits(permission, { kind: 'permission', allow: true }), true);
  assert.equal(answerFits(permission, { kind: 'question', answers: {} }), false);
  assert.equal(answerFits(question, { kind: 'permission', allow: false }), false);
});

test('a question answer names every question, and only those', () => {
  const both = {
    'Which sender domain should I use?': 'atlas.dev',
    'Keep the old sender too?': 'No, drop it',
  };
  assert.equal(answerFits(question, { kind: 'question', answers: both }), true);
  const one = { 'Which sender domain should I use?': 'atlas.dev' };
  assert.equal(answerFits(question, { kind: 'question', answers: one }), false);
  const other = { ...one, 'Something else?': 'yes' };
  assert.equal(answerFits(question, { kind: 'question', answers: other }), false);
});

test('a blank answer is refused, and a permission answer is a yes or no', () => {
  assert.equal(Answer.safeParse({ kind: 'question', answers: { q: '  ' } }).success, false);
  assert.equal(Answer.safeParse({ kind: 'permission', allow: 'always' }).success, false);
});

test('a session carries what it waits on, and who answered the last wait', () => {
  const at = '2026-10-19T12:00:00.000Z';
  const parsed = Session.parse({
    id: 's1',
    repo: 'harbor-labs/atlas-web',
    state: 'needs',
    waiting: permission,
    answered: { id: 'wait-0001', by: 'claude-code' },
    startedAt: at,
    updatedAt: at,
  });
  assert.equal(parsed.waiting?.kind, 'permission');
  assert.equal(parsed.answered?.by, 'claude-code');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Resume, Session } from '@joc/protocol';
import {
  cantResume,
  failureTitle,
  hasEnded,
  resumeOf,
  resumePhase,
  resumeStatus,
  resumeSteps,
} from './resumes.ts';

const now = Date.parse('2026-10-19T12:00:00.000Z');
const ID = '3f2a1b0c-9d8e-4f7a-8b6c-5d4e3f2a1b0c';

const session = (over: Partial<Session> = {}): Session => ({
  id: ID,
  repo: 'harbor-labs/atlas-web',
  state: 'offline',
  machine: 'harbor-mbp',
  startedAt: '2026-10-19T10:00:00.000Z',
  updatedAt: '2026-10-19T11:00:00.000Z',
  ...over,
});

const resume = (over: Partial<Resume> = {}): Resume => ({
  id: 'r1',
  sessionId: ID,
  machine: 'harbor-mbp',
  status: 'waiting',
  createdAt: '2026-10-19T11:58:00.000Z',
  ...over,
});

test('only an ended Claude Code session can be resumed', () => {
  assert.equal(cantResume(session(), now), undefined);
  assert.equal(
    cantResume(session({ state: 'idle', updatedAt: '2026-10-19T11:59:50.000Z' }), now),
    'Still running. Quit it first.',
  );
  assert.ok(cantResume(session({ id: 'not-a-uuid' }), now));
});

test("a quiet session hasn't ended until its machine still reports without it", () => {
  const quiet = session({ state: 'working', updatedAt: '2026-10-19T11:54:00.000Z' });
  assert.equal(hasEnded(session(), [], now), true);
  // The machine went quiet too, asleep say: it may still be running.
  assert.equal(hasEnded(quiet, [quiet], now), false);
  const other = session({ id: 'other', state: 'idle', updatedAt: '2026-10-19T11:59:40.000Z' });
  assert.equal(hasEnded(quiet, [quiet, other], now), true);
  // Another machine reporting says nothing about this one.
  assert.equal(hasEnded(quiet, [quiet, { ...other, machine: 'harbor-mini' }], now), false);
  // Not quiet: still running.
  assert.equal(hasEnded({ ...quiet, updatedAt: '2026-10-19T11:59:50.000Z' }, [other], now), false);
});

test('the latest resume of the session is the one that counts', () => {
  const list = [resume({ id: 'old', status: 'failed' }), resume({ id: 'new' })];
  assert.equal(resumeOf(list, ID)?.id, 'new');
  assert.equal(resumeOf(list, 'other'), undefined);
});

test('a started resume is back once the session reports, and over once it ends again', () => {
  const started = resume({ status: 'started', startedAt: '2026-10-19T11:58:30.000Z' });
  assert.equal(resumePhase(started, session()), 'loading');
  const back = session({ state: 'idle', updatedAt: '2026-10-19T11:58:20.000Z' });
  assert.equal(resumePhase(started, back), 'live');
  const endedAgain = session({ updatedAt: '2026-10-19T11:59:00.000Z' });
  assert.equal(resumePhase(started, endedAgain), 'none');
  assert.equal(resumePhase(resume({ status: 'cancelled' }), session()), 'none');
  assert.equal(resumePhase(undefined, session()), 'none');
});

test('the steps say how far it got', () => {
  const marks = (phase: Parameters<typeof resumeSteps>[0]) =>
    resumeSteps(phase, 'harbor-mbp', ID, 112).map((s) => s.status);
  assert.deepEqual(marks('waiting'), ['pending', 'todo', 'todo']);
  assert.deepEqual(marks('starting'), ['done', 'pending', 'todo']);
  assert.deepEqual(marks('loading'), ['done', 'done', 'pending']);
  const [reached, command, load] = resumeSteps('starting', 'harbor-mbp', ID, 112);
  assert.deepEqual(
    [reached?.label, command?.label, command?.mono, load?.label],
    ['Reached harbor-mbp', 'claude --resume 3f2a1b0c', true, 'Load 112 messages'],
  );
});

test('the status line names the machine, and says when nothing there can take it', () => {
  const waiting = resume();
  assert.equal(
    resumeStatus('waiting', waiting, false),
    'Start Claude Code on harbor-mbp to resume it',
  );
  assert.equal(resumeStatus('waiting', waiting, true), 'Starting on harbor-mbp…');
  const failed = resume({ status: 'failed', reason: 'session file not found' });
  assert.equal(failureTitle(failed), "Couldn't resume on harbor-mbp: session file not found");
  assert.equal(resumeStatus('failed', failed, true), failureTitle(failed));
  assert.equal(resumeStatus('none', undefined, true), undefined);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Deletion, Session } from '@joc/protocol';
import {
  cantDelete,
  deletionLine,
  deletionOf,
  machineLive,
  machinesOf,
  STILL_RUNNING,
} from './deletes.ts';

const now = Date.parse('2026-10-19T12:00:00.000Z');
const ID = '3f2a1b0c-9d8e-4f7a-8b6c-5d4e3f2a1b0c';

const session = (over: Partial<Session> = {}): Session => ({
  id: ID,
  repo: 'harbor-labs/atlas-web',
  state: 'offline',
  machine: 'harbor-mbp',
  startedAt: '2026-10-19T10:00:00.000Z',
  updatedAt: '2026-10-19T11:59:30.000Z',
  ...over,
});

const deletion = (over: Partial<Deletion> = {}): Deletion => ({
  id: 'd1',
  sessionId: ID,
  machine: 'harbor-mbp',
  status: 'waiting',
  createdAt: '2026-10-19T12:00:00.000Z',
  ...over,
});

test('only an ended session, or one quiet long enough to have stopped, can be deleted', () => {
  assert.equal(cantDelete(session(), now), undefined);
  assert.equal(cantDelete(session({ state: 'idle' }), now), STILL_RUNNING);
  const quiet = session({ state: 'idle', updatedAt: '2026-10-19T11:50:00.000Z' });
  assert.equal(cantDelete(quiet, now), undefined);
  assert.match(cantDelete(session({ machine: undefined }), now) ?? '', /which machine/);
  assert.match(cantDelete(session({ id: 'shared-id' }), now) ?? '', /Not a Claude Code session/);
});

test('a waiting delete says plainly when no session on the machine can take it', () => {
  assert.equal(deletionLine(deletion(), true), 'Deleting on harbor-mbp…');
  assert.equal(deletionLine(deletion(), false), 'Start Claude Code on harbor-mbp to delete it.');
  assert.equal(deletionLine(deletion({ status: 'deleting' }), false), 'Deleting on harbor-mbp…');
  assert.equal(
    deletionLine(deletion({ status: 'failed', detail: 'Still running on harbor-mbp.' }), true),
    "Couldn't delete it. Still running on harbor-mbp.",
  );
  assert.equal(deletionLine(deletion({ status: 'deleted' }), true), undefined);
});

test('the newest delete of a session counts, and a machine is live while a session reports', () => {
  const old = deletion({ id: 'a', status: 'failed' });
  const fresh = deletion({ id: 'b' });
  assert.equal(deletionOf([old, fresh], ID)?.id, 'b');
  assert.equal(machineLive([session()], 'harbor-mbp', now), false);
  assert.equal(machineLive([session({ state: 'working' })], 'harbor-mbp', now), true);
  assert.equal(machineLive([session({ state: 'working' })], 'tide-mini', now), false);
});

test('the confirm dialog names one machine, or how many', () => {
  assert.equal(machinesOf([session()]), 'harbor-mbp');
  assert.equal(machinesOf([session(), session({ machine: 'tide-mini' })]), '2 machines');
});

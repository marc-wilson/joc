import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Session } from '@joc/protocol';
import { isQuiet, keepNote, matchesFilter } from './session-list.ts';

const now = Date.parse('2026-10-18T12:00:00.000Z');
const session = (fields: Partial<Session> = {}): Session => ({
  id: 's1',
  title: 'Fix the invoice export',
  repo: 'harbor-labs/atlas-web',
  branch: 'fix/invoice-export',
  state: 'idle',
  startedAt: '2026-10-18T09:00:00.000Z',
  updatedAt: '2026-10-18T11:59:30.000Z',
  ...fields,
});

test('the note says what the list leaves out', () => {
  assert.equal(
    keepNote({ quiet: '1w', ended: '1d' }),
    'Quiet sessions leave after 1 week, ended ones leave after 1 day.',
  );
  assert.equal(
    keepNote({ quiet: '30d', ended: 'now' }),
    'Quiet sessions leave after 1 month, ended ones leave right away.',
  );
  assert.equal(
    keepNote({ quiet: '1d', ended: '1d' }),
    'Quiet and ended sessions leave after 1 day.',
  );
});

test('the filter matches title, repo or branch, ignoring case', () => {
  assert.equal(matchesFilter(session(), 'INVOICE'), true);
  assert.equal(matchesFilter(session(), 'atlas-web'), true);
  assert.equal(matchesFilter(session(), 'fix/'), true);
  assert.equal(matchesFilter(session(), 'billing'), false);
  assert.equal(matchesFilter(session(), '  '), true);
  assert.equal(matchesFilter(session({ title: undefined, branch: undefined }), 'invoice'), false);
});

test('a session is quiet once it stops syncing, unless it ended', () => {
  assert.equal(isQuiet(session(), now), false);
  assert.equal(isQuiet(session({ updatedAt: '2026-10-18T09:00:00.000Z' }), now), true);
  assert.equal(
    isQuiet(session({ state: 'offline', updatedAt: '2026-10-18T09:00:00.000Z' }), now),
    false,
  );
});

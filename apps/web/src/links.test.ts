import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PullRequest, Session } from '@joc/protocol';
import { prFor, sessionFor, sessionForThread } from './links.ts';
import { duration } from './time.ts';

const pr: PullRequest = {
  number: 238,
  title: 'Migrate transactional mail to Resend',
  url: 'https://github.example/harbor-labs/atlas-api/pull/238',
  repo: 'harbor-labs/atlas-api',
  branch: 'feat/resend-mailer',
  author: 'priya',
  updatedAt: '2026-10-18T10:00:00.000Z',
  draft: false,
  additions: 1,
  deletions: 1,
  ci: 'pending',
};
const session = (id: string, branch: string, updatedAt: string): Session => ({
  id,
  repo: 'harbor-labs/atlas-api',
  branch,
  state: 'idle',
  startedAt: '2026-10-18T09:00:00.000Z',
  updatedAt,
});

test('a PR links to the latest session on its repo and branch', () => {
  const older = session('a', 'feat/resend-mailer', '2026-10-18T09:30:00.000Z');
  const newer = session('b', 'feat/resend-mailer', '2026-10-18T09:50:00.000Z');
  const other = session('c', 'main', '2026-10-18T09:59:00.000Z');
  assert.equal(sessionFor(pr, [older, other, newer])?.id, 'b');
  assert.equal(sessionFor(pr, [other]), undefined);
  assert.equal(prFor(newer, [pr])?.number, 238);
  assert.equal(prFor(other, [pr]), undefined);
});

test('durations read naturally', () => {
  const at = (m: number) => new Date(Date.UTC(2026, 9, 18, 0, m)).toISOString();
  assert.equal(duration(at(0), at(0)), '0s');
  assert.equal(duration(at(0), at(12)), '12m');
  assert.equal(duration(at(0), at(200)), '3h 20m');
  assert.equal(duration(at(0), at(180)), '3h');
  assert.equal(duration(at(0), at(60 * 50)), '2d');
});

test("a notification links to the live session on its pull request's or CI run's branch", () => {
  const live = session('a', 'feat/resend-mailer', '2026-10-18T09:30:00.000Z');
  const main = session('b', 'main', '2026-10-18T09:30:00.000Z');
  const ended = { ...session('c', 'main', '2026-10-18T09:40:00.000Z'), state: 'offline' as const };
  const repo = 'harbor-labs/atlas-api';
  assert.equal(sessionForThread({ repo, number: 238 }, [pr], [live, main])?.id, 'a');
  assert.equal(sessionForThread({ repo, number: 239 }, [pr], [live, main]), undefined);
  // An ended session can't take a prompt.
  assert.equal(sessionForThread({ repo, branch: 'main' }, [], [main, ended])?.id, 'b');
});

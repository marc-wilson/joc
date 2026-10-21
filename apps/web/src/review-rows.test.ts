import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Launch, PullRequest, Session } from '@joc/protocol';
import { prReviewRows, REVIEW_LINGER_MS, reviewGone, reviewRowText } from './review-rows.ts';

const now = Date.parse('2026-10-18T10:00:00.000Z');
const ago = (ms: number) => new Date(now - ms).toISOString();
const review = { repo: 'harbor-labs/atlas-web', number: 512 };
const reviewing = (state: Session['state'], extra: Partial<Session> = {}): Session => ({
  id: 'rv1',
  repo: review.repo,
  title: 'Review harbor-labs/atlas-web#512',
  state,
  review,
  startedAt: ago(20 * 60_000),
  updatedAt: ago(0),
  activeAt: ago(4 * 60_000),
  ...extra,
});
const pr = { repo: review.repo, number: 512, title: 'Cache GraphQL persisted queries' };

test('a live review shows its PR title, the PR in short and what it does', () => {
  assert.deepEqual(
    reviewRowText(reviewing('working'), [pr as PullRequest], 'Reading 9 of 14 files', now),
    {
      done: false,
      title: 'Cache GraphQL persisted queries',
      pr: 'atlas-web#512',
      prTitle: 'harbor-labs/atlas-web#512',
      time: 'now',
      activity: 'Reading 9 of 14 files',
    },
  );
});

test('a finished review says when it finished; without the PR from GitHub, its own title', () => {
  const text = reviewRowText(reviewing('idle'), [], '3 comments posted', now);
  assert.deepEqual(
    [text?.done, text?.title, text?.time],
    [true, reviewing('idle').title, 'Done 4m'],
  );
  // The outcome tag says how it went, so the line doesn't say it again.
  const approved = reviewRowText(reviewing('idle'), [], 'Approved: 1 nit left inline.', now);
  assert.equal(approved?.activity, '1 nit left inline.');
  // An ended one has no last words to show.
  assert.equal(reviewRowText(reviewing('offline'), [], 'Session ended', now)?.activity, undefined);
});

test('a finished review leaves after a while, or once cleared; a live one stays', () => {
  const old = { activeAt: ago(REVIEW_LINGER_MS + 1) };
  assert.equal(reviewGone(reviewing('idle'), [], now), false);
  assert.equal(reviewGone(reviewing('idle', old), [], now), true);
  assert.equal(reviewGone(reviewing('idle'), ['rv1'], now), true);
  assert.equal(reviewGone(reviewing('working', old), ['rv1'], now), false);
});

test("a PR's reviews: command-started and button-started sessions, live or past, newest first", () => {
  const byCommand = reviewing('working', {
    id: 'rv-cmd',
    title: 'Review #512 by command',
    activity: 'Reading 9 of 14 files',
    startedAt: ago(5 * 60_000),
  });
  const past = reviewing('idle', {
    id: 'rv-past',
    title: 'First pass',
    review: { ...review, outcome: 'Approved' },
    activity: 'Approved: 1 nit left inline.',
    startedAt: ago(3 * 3_600_000),
    activeAt: ago(2 * 3_600_000),
  });
  const other = reviewing('working', { id: 'rv-other', review: { ...review, number: 9 } });
  const launch: Launch = {
    id: 'l1',
    from: 's1',
    review: { ...review, url: 'https://github.com/harbor-labs/atlas-web/pull/512' },
    status: 'failed',
    detail: 'No session on harbor-mbp could start it.',
    createdAt: ago(60_000),
  };
  // The launch whose session reported shows once, as that session.
  const started: Launch = { ...launch, id: 'l2', status: 'started', sessionId: 'rv-cmd' };
  const rows = prReviewRows(review, [byCommand, other], [past, byCommand], [launch, started], now);
  assert.deepEqual(
    rows.map((r) => [r.key, r.state, r.result, r.status, r.time]),
    [
      ['l1', 'idle', 'fail', 'No session on harbor-mbp could start it.', '1m'],
      ['rv-cmd', 'working', undefined, 'Reading 9 of 14 files', 'now'],
      ['rv-past', 'idle', 'pass', 'Approved · 1 nit left inline.', '2h'],
    ],
  );
  // An ended review without Claude's word on it just ended.
  const ended = reviewing('offline', { activity: 'Session ended' });
  assert.equal(prReviewRows(review, [], [ended], [], now)[0]?.status, 'Session ended');
});

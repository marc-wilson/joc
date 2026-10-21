import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConversationItem, PullRequest, Session } from '@joc/protocol';
import { notPosted, reviewSteps, verdictSummary, yourReview } from './review-pr.ts';

const review = { repo: 'harbor-labs/atlas-web', number: 482 };
const session = (extra: Partial<Session> = {}): Session => ({
  id: 'rv1',
  repo: review.repo,
  state: 'working',
  review,
  startedAt: '2026-10-20T10:00:00.000Z',
  updatedAt: '2026-10-20T10:05:00.000Z',
  ...extra,
});
const pull = (extra: Partial<PullRequest> = {}): PullRequest => ({
  number: 482,
  title: 'Fix OAuth redirect loop after token refresh',
  url: 'https://github.com/harbor-labs/atlas-web/pull/482',
  repo: review.repo,
  branch: 'fix/auth-redirect',
  author: 'dokafor',
  updatedAt: '2026-10-20T10:00:00.000Z',
  draft: false,
  additions: 86,
  deletions: 12,
  ci: 'fail',
  ...extra,
});
let n = 0;
const call = (name: string, summary: string): ConversationItem => ({
  id: `t${++n}`,
  at: '2026-10-20T10:01:00.000Z',
  kind: 'tool_call',
  toolUseId: `u${n}`,
  name,
  summary,
});
const said = (text: string): ConversationItem => ({
  id: `c${++n}`,
  at: '2026-10-20T10:02:00.000Z',
  kind: 'claude',
  text,
});

test("a review's steps follow its conversation, the current one while it works", () => {
  const items = [
    call('Bash', 'gh pr checkout 482'),
    call('Read', 'apps/web/src/auth/callback.ts'),
    call('Read', 'apps/web/src/auth/session.ts'),
    call('Read', 'apps/web/src/auth/callback.ts'),
    call('Bash', 'pnpm nx test auth'),
  ];
  const steps = reviewSteps(session(), pull(), items);
  assert.deepEqual(
    steps.map((s) => [s.text, s.code, s.status]),
    [
      ['Fetched #482', undefined, 'done'],
      ['Checked out', 'fix/auth-redirect', 'done'],
      ['Read 2 files', undefined, 'done'],
      ['Running', 'pnpm nx test auth', 'now'],
      ['Draft review', undefined, 'next'],
      ['Post to GitHub', undefined, 'next'],
    ],
  );
  // Idle, nothing is current; once Claude said how it went, every step is done.
  assert.equal(
    reviewSteps(session({ state: 'idle' }), pull(), items).some((s) => s.status === 'now'),
    false,
  );
  const posted = session({ state: 'idle', review: { ...review, outcome: 'Changes requested' } });
  assert.ok(reviewSteps(posted, pull(), []).every((s) => s.status === 'done'));
});

test("your review is your latest on GitHub, and Claude's summary its last message's first paragraph", () => {
  const reviews: PullRequest['reviews'] = [
    { by: { login: 'Kai' }, state: 'commented', submittedAt: '2026-10-20T10:50:00.000Z' },
    { by: { login: 'samlee' }, state: 'approved' },
    { by: { login: 'kai' }, state: 'changes-requested', submittedAt: '2026-10-20T10:58:00.000Z' },
  ];
  assert.equal(yourReview(pull({ reviews }), 'kai')?.state, 'changes-requested');
  assert.equal(yourReview(pull({ reviews }), undefined), undefined);
  const text = 'Requested changes: the **loop fix** is right.\n\nMore detail follows.';
  assert.equal(
    verdictSummary([said('Looking.'), said(text)]),
    'Requested changes: the loop fix is right.',
  );
  assert.equal(verdictSummary([]), undefined);
});

test('a review merged or closed before Claude posted is not posted', () => {
  assert.equal(notPosted(session(), pull({ state: 'merged' })), true);
  assert.equal(notPosted(session(), pull({ state: 'open' })), false);
  const done = session({ review: { ...review, outcome: 'Approved' } });
  assert.equal(notPosted(done, pull({ state: 'merged' })), false);
});

// Operations' live activity and throughput: which changes become events, how the log stays
// bounded, and what a week of merges keeps. Made-up harbor-labs data only.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { closeClient, getDb } from '@joc/db';
import { ACTIVITY_KEEP, type PullRequest } from '@joc/protocol';
import {
  type ActivityLists,
  githubActivity,
  listActivity,
  recordActivity,
  sessionActivity,
} from './activity.ts';
import { bus } from './bus.ts';
import { keepMerges, listMerges } from './merges.ts';
import { ownerFrom } from './owner.ts';
import { applyReport } from './sessions.ts';
import { useTestDb } from './test-db.ts';

before(() => useTestDb('joc_activity_test'));
after(() => closeClient());

const NOW = Date.parse('2026-10-21T12:00:00.000Z');
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

const pr = (number: number, extra: Partial<PullRequest> = {}): PullRequest => ({
  number,
  title: `Pull request ${number}`,
  url: `https://github.com/harbor-labs/billing-api/pull/${number}`,
  repo: 'harbor-labs/billing-api',
  branch: `feat/${number}`,
  author: 'rowan',
  updatedAt: at(5),
  createdAt: at(30),
  draft: false,
  additions: 10,
  deletions: 2,
  ci: 'pending',
  ...extra,
});

const lists = (mine: PullRequest[], more: Partial<ActivityLists> = {}): ActivityLists => ({
  reviewRequested: [],
  mine,
  updatedAt: new Date(NOW - 60_000),
  ...more,
});

test('a session state change says what Claude did; a sync or an end says nothing', () => {
  const s = (state: 'working' | 'needs' | 'idle' | 'background' | 'offline') => ({
    id: 'a',
    state,
    repo: 'harbor-labs/atlas-web',
    title: 'Blog: RSS feed',
  });
  const kinds = (
    [
      [undefined, 'working'],
      ['idle', 'working'],
      ['needs', 'working'],
      ['working', 'needs'],
      ['working', 'background'],
      ['background', 'idle'],
      ['working', 'idle'],
      ['idle', 'idle'],
      ['idle', 'offline'],
    ] as const
  ).map(([from, to]) => sessionActivity(from, s(to))?.kind);
  assert.deepEqual(kinds, [
    'started',
    'started',
    // Answering it carries on the same turn.
    undefined,
    'asked',
    'background',
    'finished',
    'finished',
    undefined,
    undefined,
  ]);
  assert.deepEqual(sessionActivity('idle', s('working')), {
    kind: 'started',
    repo: 'harbor-labs/atlas-web',
    title: 'Blog: RSS feed',
    sessionId: 'a',
  });
});

test('GitHub news: opened, CI passed and failed, reviews, merges and deploys', () => {
  const was = lists([pr(215, { ci: 'pending' }), pr(218, { ci: 'pending' }), pr(97)]);
  const now = lists(
    [
      pr(215, {
        ci: 'pass',
        checks: Array.from({ length: 12 }, (_, i) => ({ name: `check-${i}`, status: 'pass' })),
        reviews: [
          {
            by: { login: 'sam', name: 'Sam Achebe' },
            state: 'changes-requested',
            submittedAt: at(1),
          },
        ],
      }),
      pr(218, { ci: 'fail', checks: [{ name: 'unit-tests', status: 'fail' }] }),
      pr(221, { createdAt: at(0) }),
    ],
    {
      recent: [
        pr(97, {
          state: 'merged',
          mergedAt: at(1),
          deploy: { environment: 'production', status: 'fail', at: at(0) },
        }),
      ],
    },
  );
  assert.deepEqual(
    githubActivity(was, now).map((e) => [e.kind, e.number, e.status, e.detail, e.by, e.review]),
    [
      ['ci', 215, 'pass', '12 checks', undefined, undefined],
      ['review', 215, undefined, undefined, 'Sam Achebe', 'changes'],
      ['ci', 218, 'fail', 'unit-tests', undefined, undefined],
      ['opened', 221, undefined, undefined, undefined, undefined],
      ['merged', 97, undefined, undefined, undefined, undefined],
      ['deploy', 97, 'fail', 'production', undefined, undefined],
    ],
  );
  // The same copy again is no news, and neither is the first copy.
  assert.deepEqual(githubActivity(now, now), []);
  assert.deepEqual(githubActivity(null, now), []);
  // Merges from before the last copy were already there: a backfill isn't news.
  const old = lists([], { recent: [pr(90, { state: 'merged', mergedAt: at(600) })] });
  assert.deepEqual(githubActivity(lists([]), old), []);
});

test('the log keeps each owner their own latest events, newest first, and streams them', async () => {
  const heard: unknown[] = [];
  const stop = bus.subscribe(ownerFrom('gh_1'), (m) => heard.push(m));
  const ev = (n: number) => ({
    kind: 'merged' as const,
    repo: 'harbor-labs/atlas-web',
    title: `Merge ${n}`,
    number: n,
  });
  await recordActivity(ownerFrom('gh_1'), [ev(1), ev(2)], NOW);
  await recordActivity(ownerFrom('gh_2'), [ev(3)], NOW);
  stop();
  const mine = await listActivity(ownerFrom('gh_1'));
  assert.deepEqual(
    mine.map((e) => e.title),
    ['Merge 2', 'Merge 1'],
  );
  assert.deepEqual(
    (await listActivity(ownerFrom('gh_2'))).map((e) => e.title),
    ['Merge 3'],
  );
  assert.equal(heard.length, 1);
  assert.deepEqual(
    (heard[0] as { events: { title: string }[] }).events.map((e) => e.title),
    ['Merge 2', 'Merge 1'],
  );

  // Past ACTIVITY_KEEP, the oldest go.
  const many = Array.from({ length: ACTIVITY_KEEP + 5 }, (_, i) => ev(100 + i));
  await recordActivity(ownerFrom('gh_1'), many, NOW + 1_000);
  const left = await getDb().collection('activity').countDocuments({ owner: 'gh_1' });
  assert.equal(left, ACTIVITY_KEEP);
  const latest = await listActivity(ownerFrom('gh_1'), 1);
  assert.equal(latest[0]?.title, `Merge ${100 + ACTIVITY_KEEP + 4}`);
});

test('a report that changes the state records it', async () => {
  const owner = ownerFrom('gh_3');
  const base = { sessionId: 'rss', repo: 'harbor-labs/marketing-site', title: 'Blog: RSS feed' };
  await applyReport(owner, { ...base, at: 1, state: 'idle' });
  await applyReport(owner, { ...base, at: 2, state: 'working' });
  await applyReport(owner, { ...base, at: 3 });
  await applyReport(owner, { ...base, at: 4, state: 'needs' });
  assert.deepEqual(
    (await listActivity(owner)).map((e) => [e.kind, e.title, e.sessionId]),
    [
      ['asked', 'Blog: RSS feed', 'rss'],
      ['started', 'Blog: RSS feed', 'rss'],
    ],
  );
});

test('merges keep for a week, with their first deploy and when the session started', async () => {
  const owner = ownerFrom('gh_4');
  await applyReport(owner, {
    sessionId: 'tax',
    at: 1,
    state: 'working',
    repo: 'Harbor-Labs/billing-api',
    branch: 'feat/210',
  });
  // It started an hour before the merge.
  await getDb()
    .collection('sessions')
    .updateOne(
      { owner, sessionId: 'tax' },
      { $set: { createdAt: new Date(Date.now() - 3_600_000) } },
    );
  const merged = (n: number, extra: Partial<PullRequest> = {}) =>
    pr(n, { state: 'merged', mergedAt: new Date(Date.now() - 60_000).toISOString(), ...extra });
  await keepMerges(owner, [merged(210), merged(212), pr(214)]);
  const pass = { environment: 'production', status: 'pass' as const };
  const first = new Date(Date.now() - 30_000).toISOString();
  await keepMerges(owner, [merged(210, { deploy: { ...pass, at: first } })]);
  // A later deploy doesn't move the first.
  await keepMerges(owner, [merged(210, { deploy: { ...pass, at: new Date().toISOString() } })]);
  const kept = await listMerges(owner);
  assert.deepEqual(kept.map((m) => [m.number, m.deployedAt, !!m.sessionStartedAt]).sort(), [
    [210, first, true],
    [212, undefined, false],
  ]);
  assert.deepEqual(await listMerges(ownerFrom('gh_5')), []);
});

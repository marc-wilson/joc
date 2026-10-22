// The GitHub App's webhooks, end to end: signed fixture deliveries into the app, against
// the run's MongoDB replica set, and what each person then sees.
import assert from 'node:assert/strict';
import { createHmac, createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import { after, before, test } from 'node:test';
import { closeClient } from '@joc/db';
import {
  Alert,
  GitHubSnapshot,
  Operations,
  ReviewedPullRequest,
  SessionChanges,
} from '@joc/protocol';
import { z } from 'zod';
import { createApp } from './app.ts';
import type { GitHubAuth } from './github.ts';
import { appJwt, type GitHubAppApi, parsePrivateKey } from './github-app.ts';
import { backfillOwner, mentions } from './github-events.ts';
import {
  checkRunEvent,
  commentEvent,
  delivery,
  installationEvent,
  PEOPLE,
  pull,
  pullEvent,
  REPO,
  reviewEvent,
} from './github-fixtures.ts';
import { createWebhooks, verifySignature } from './github-webhook.ts';
import { createDeviceToken, signInGitHubUser } from './identity.ts';
import type { Owner } from './owner.ts';
import { useTestDb } from './test-db.ts';

const SECRET = 'webhook-test-secret';

/** A stand-in for GitHub's API, as the App reads it: by path. */
const answers = new Map<string, unknown>();
/** Every path the App read, in order. */
const asked: string[] = [];
const api: GitHubAppApi = {
  get: async (_installation, path) => {
    asked.push(path);
    return answers.get(path);
  },
  about: async () => ({ slug: 'joc-dashboard', name: 'JOC Dashboard' }),
};
const webhooks = createWebhooks(SECRET, { api });
const github: GitHubAuth = {
  authorizeUrl: () => 'https://github.example/authorize',
  profileFor: async () => undefined,
};
const app = createApp({ github, publicUrl: 'http://joc.test', pluginVersion: '1.0.0', webhooks });

type Who = keyof typeof PEOPLE;
const tokens = new Map<Who, string>();
const owners = new Map<Who, Owner>();

before(async () => {
  await useTestDb('joc_webhook_test');
  for (const who of ['alice', 'bob', 'dana'] as const) {
    // They signed in before the App was installed: the install covers them.
    const owner = await signInGitHubUser(PEOPLE[who]);
    owners.set(who, owner);
    tokens.set(who, await createDeviceToken(owner, `${who}-laptop`));
  }
  // The org's members, as the App reads them when it's installed.
  answers.set('/orgs/harbor-labs/members?per_page=100&page=1', [
    PEOPLE.alice,
    PEOPLE.bob,
    PEOPLE.dana,
  ]);
  answers.set('/orgs/harbor-labs/teams/web/members?per_page=100', [PEOPLE.dana]);
  answers.set(`/repos/${REPO}/pulls/7/files?per_page=100`, [
    { filename: 'src/auth.ts', status: 'modified', additions: 10, deletions: 3 },
    { filename: 'src/old.ts', status: 'removed', additions: 0, deletions: 2 },
  ]);
});

after(async () => {
  await webhooks.idle();
  await closeClient();
});

const send = async (event: string, payload: unknown, id?: string) => {
  const res = await app.request('/api/github/webhook', delivery(SECRET, event, payload, id));
  await webhooks.idle();
  return res;
};

const get = (who: Who, path: string) =>
  app.request(path, { headers: { authorization: `Bearer ${tokens.get(who)}` } });

async function lists(who: Who) {
  const snapshot = GitHubSnapshot.parse(await (await get(who, '/api/github')).json());
  assert.equal(snapshot.state, 'reported');
  return snapshot.state === 'reported' ? snapshot : { reviewRequested: [], mine: [] };
}

const alerts = async (who: Who) =>
  z.array(Alert).parse(await (await get(who, '/api/alerts')).json());

test('a signature is checked in constant time against the exact body', () => {
  const body = '{"zen":"Keep it logically awesome."}';
  const { headers } = delivery(SECRET, 'ping', JSON.parse(body));
  assert.equal(verifySignature(SECRET, body, headers['x-hub-signature-256']), true);
  assert.equal(verifySignature(SECRET, `${body} `, headers['x-hub-signature-256']), false);
  assert.equal(verifySignature('other', body, headers['x-hub-signature-256']), false);
  assert.equal(verifySignature(SECRET, body, 'sha256=zz'), false);
  assert.equal(verifySignature(SECRET, body, undefined), false);
});

test('a delivery that is not signed by the secret is refused, and a bad body too', async () => {
  const forged = delivery('guess', 'pull_request', pullEvent('opened'));
  assert.equal((await app.request('/api/github/webhook', forged)).status, 401);
  const body = 'not json';
  const signed = delivery(SECRET, 'pull_request', {});
  const sig = createHmac('sha256', SECRET).update(body).digest('hex');
  const res = await app.request('/api/github/webhook', {
    ...signed,
    body,
    headers: { ...signed.headers, 'x-hub-signature-256': `sha256=${sig}` },
  });
  assert.equal(res.status, 400);
  // Nobody is covered yet: machines still read GitHub themselves.
  assert.equal((await get('alice', '/api/sessions')).headers.get('x-joc-github'), null);
});

test('installing the App on the org covers its members who use JOC', async () => {
  assert.equal((await send('installation', installationEvent('created'))).status, 202);
  assert.equal((await get('alice', '/api/sessions')).headers.get('x-joc-github'), 'app');
  assert.equal((await get('dana', '/api/sessions')).headers.get('x-joc-github'), 'app');
  // Covered with nothing open yet: empty lists, not "connect gh".
  const bob = await lists('bob');
  assert.deepEqual([bob.reviewRequested, bob.mine], [[], []]);
});

test('a pull request reaches its author and requested reviewers, a team through its members', async () => {
  await send('pull_request', pullEvent('opened', { reviewers: [PEOPLE.bob], teams: ['web'] }));
  const [mine] = (await lists('alice')).mine;
  assert.equal(mine?.number, 7);
  assert.equal(mine?.review, 'Review requested');
  assert.equal(mine?.ci, 'skipped');
  assert.deepEqual(
    mine?.files?.map((f) => [f.path, f.status]),
    [
      ['src/auth.ts', 'modified'],
      ['src/old.ts', 'deleted'],
    ],
  );
  assert.deepEqual(
    (await lists('bob')).reviewRequested.map((p) => p.number),
    [7],
  );
  assert.deepEqual(
    (await lists('dana')).reviewRequested.map((p) => p.number),
    [7],
  );
  assert.deepEqual(
    (await alerts('bob')).map((a) => [a.kind, a.number, a.read]),
    [['review', 7, false]],
  );
});

test('a redelivery is taken once', async () => {
  const id = 'b5d7e0a0-0000-4000-8000-000000000001';
  const payload = commentEvent(PEOPLE.bob, 'Ping @dana');
  assert.equal((await send('issue_comment', payload, id)).status, 202);
  assert.equal((await send('issue_comment', payload, id)).status, 200);
  assert.deepEqual(
    (await alerts('dana')).filter((a) => a.kind === 'mention').map((a) => a.detail),
    ['bob'],
  );
  // And a comment on Alice's pull request is news for Alice.
  assert.deepEqual(
    (await alerts('alice')).map((a) => [a.kind, a.url?.includes('#issuecomment-')]),
    [['comment', true]],
  );
});

test('a review submitted resolves the request and sets the decision', async () => {
  await send(
    'pull_request_review',
    reviewEvent('submitted', PEOPLE.bob, 'changes_requested', { teams: ['web'] }),
  );
  assert.deepEqual((await lists('bob')).reviewRequested, []);
  assert.equal((await lists('alice')).mine[0]?.review, 'Changes requested');
  assert.deepEqual(
    (await alerts('bob')).map((a) => [a.kind, a.read]),
    [['review', true]],
  );
  // The request withdrawn from the team: Dana isn't asked any more.
  await send('pull_request', pullEvent('review_request_removed', {}));
  assert.deepEqual((await lists('dana')).reviewRequested, []);
});

test('failed CI alerts the author; passing again resolves it', async () => {
  await send('check_run', checkRunEvent('test', 'in_progress', null));
  assert.equal((await lists('alice')).mine[0]?.ci, 'pending');
  await send('check_run', checkRunEvent('test', 'completed', 'failure'));
  const failed = (await lists('alice')).mine[0];
  assert.deepEqual([failed?.ci, failed?.ciDetail], ['fail', '0/1']);
  assert.deepEqual(failed?.checks, [{ name: 'test', status: 'fail', seconds: 90 }]);
  const ci = () => alerts('alice').then((l) => l.filter((a) => a.kind === 'ci-failed'));
  assert.deepEqual(
    (await ci()).map((a) => a.read),
    [false],
  );
  await send('check_run', checkRunEvent('test', 'completed', 'success'));
  assert.deepEqual([(await lists('alice')).mine[0]?.ci], ['pass']);
  assert.deepEqual(
    (await ci()).map((a) => a.read),
    [true],
  );
  // Another commit's check says nothing about this one.
  await send('check_run', checkRunEvent('test', 'completed', 'failure', 'ffffff'));
  assert.equal((await lists('alice')).mine[0]?.ci, 'pass');
});

test("a check's detail line comes from its output: the title, else the summary's first line", async () => {
  const output = (title: string | null, summary: string | null) => ({ title, summary });
  await send(
    'check_run',
    checkRunEvent('e2e', 'in_progress', null, 'a1b2c3', output(null, '## Running\n14 of 38')),
  );
  const check = async () =>
    (await lists('alice')).mine[0]?.checks?.find((c) => c.name === 'e2e')?.detail;
  assert.equal(await check(), 'Running');
  const long = 'x'.repeat(300);
  await send(
    'check_run',
    checkRunEvent('e2e', 'completed', 'failure', 'a1b2c3', output(`2 failed ${long}`, 'more')),
  );
  assert.equal((await check())?.length, 200);
  assert.ok((await check())?.startsWith('2 failed x'));
  // Nothing said: no detail.
  await send('check_run', checkRunEvent('e2e', 'completed', 'success'));
  assert.equal(await check(), undefined);
});

test('an older copy of a pull request than the one kept is dropped', async () => {
  const stale = pullEvent('edited', { title: 'Old title' });
  stale.pull_request.updated_at = '2026-01-01T00:00:00.000Z';
  await send('pull_request', stale);
  assert.equal((await lists('alice')).mine[0]?.title, 'Fix the auth redirect');
});

test('a merged pull request leaves every list', async () => {
  await send('pull_request', pullEvent('closed', { state: 'closed', merged: true }));
  assert.deepEqual((await lists('alice')).mine, []);
});

const operations = async (who: Who) =>
  Operations.parse(await (await get(who, '/api/operations')).json());

test('a merge stays on Operations for its author, and ships once its deploy is reported', async () => {
  const now = new Date().toISOString();
  const merge = 'd4e5f6a7b8c9';
  await send(
    'pull_request',
    pullEvent('closed', {
      number: 8,
      state: 'closed',
      merged: true,
      extra: { closed_at: now, merged_at: now, merge_commit_sha: merge },
    }),
  );
  const row = async () => (await operations('alice')).rows.find((r) => r.id === `pr:${REPO}#8`);
  // No deploys reported in the repo yet: merged is shipped.
  assert.deepEqual([(await row())?.pull?.state, (await row())?.shippedAt], ['merged', now]);
  // Bob isn't on it: nothing of it reaches him.
  assert.equal(
    (await operations('bob')).rows.some((r) => r.id === `pr:${REPO}#8`),
    false,
  );

  const deployment = (state: string, at: string) => ({
    ...{ installation: { id: 77 }, repository: { full_name: REPO } },
    deployment: { sha: merge, environment: 'production' },
    deployment_status: { state, environment: 'production', created_at: at, updated_at: at },
  });
  await send(
    'deployment_status',
    deployment('in_progress', new Date(Date.now() + 1000).toISOString()),
  );
  assert.deepEqual((await operations('alice')).deployRepos, [REPO]);
  assert.deepEqual(
    [(await row())?.pull?.deploy?.status, (await row())?.shippedAt],
    ['pending', undefined],
  );
  const failed = new Date(Date.now() + 2000).toISOString();
  await send('deployment_status', deployment('failure', failed));
  assert.deepEqual((await row())?.needs, ['deploy']);
  // A deploy workflow on the default branch counts as well: it deployed.
  const done = new Date(Date.now() + 3000).toISOString();
  await send('workflow_run', {
    action: 'completed',
    installation: { id: 77 },
    repository: { full_name: REPO, default_branch: 'main' },
    workflow_run: {
      name: 'Deploy',
      head_sha: merge,
      head_branch: 'main',
      event: 'push',
      status: 'completed',
      conclusion: 'success',
      updated_at: done,
      html_url: `https://github.com/${REPO}/actions/runs/1`,
    },
  });
  const shipped = await row();
  assert.deepEqual(
    [shipped?.pull?.deploy?.environment, shipped?.shippedAt, shipped?.needs],
    ['Deploy', done, []],
  );
});

test('signing in reads the open pull requests once', async () => {
  answers.set(
    `/search/issues?q=${encodeURIComponent('is:pr is:open archived:false author:bob')}&per_page=50`,
    { items: [{ number: 12, repository_url: `https://api.github.com/repos/${REPO}` }] },
  );
  answers.set(`/repos/${REPO}/pulls/12`, pull({ number: 12, author: PEOPLE.bob, sha: 'c0ffee' }));
  answers.set(`/repos/${REPO}/commits/c0ffee/check-runs?per_page=100`, {
    check_runs: [{ name: 'lint', status: 'completed', conclusion: 'success' }],
  });
  answers.set(`/repos/${REPO}/commits/c0ffee/status`, {
    statuses: [{ context: 'deploy/preview', state: 'pending' }],
  });
  answers.set(`/repos/${REPO}/pulls/12/reviews?per_page=100`, [
    { user: PEOPLE.alice, state: 'APPROVED' },
  ]);
  await backfillOwner(webhooks.context, owners.get('bob') as Owner);
  const [mine] = (await lists('bob')).mine;
  assert.deepEqual(
    [mine?.number, mine?.review, mine?.ci, mine?.ciDetail],
    [12, 'Approved', 'pending', '1/2'],
  );
});

const avatar = (id: number) => `https://avatars.githubusercontent.com/u/${id}?v=4`;

/** A session of `who`'s whose first prompt reviews `target`. */
const reviewSession = (who: Who, sessionId: string, target: string) =>
  app.request('/api/reports', {
    method: 'POST',
    headers: { authorization: `Bearer ${tokens.get(who)}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      at: Date.now(),
      state: 'working',
      repo: REPO,
      title: `/code-review ${target}`,
    }),
  });

const reviewed = async (who: Who, sessionId: string) => {
  const res = await get(who, `/api/sessions/${sessionId}/review`);
  assert.equal(res.status, 200);
  return ReviewedPullRequest.parse(await res.json());
};

test('a review session shows the pull request it reviews, whole', async () => {
  const body = [
    'Moves the redirect after sign-in.',
    '',
    'Closes #12, fixes harbor-labs/atlas-api#3.',
    '<img src="x" onerror="alert(1)">',
  ].join('\n');
  const extra = {
    body,
    created_at: '2026-10-19T08:00:00Z',
    user: { ...PEOPLE.alice, avatar_url: avatar(1), type: 'User' },
    labels: [
      { name: 'bug', color: 'd73a4a' },
      { name: 'odd', color: 'not-a-colour' },
    ],
    milestone: {
      title: 'October',
      number: 4,
      html_url: `https://github.com/${REPO}/milestone/4`,
      due_on: '2026-10-31T07:00:00Z',
    },
    commits: 3,
    mergeable: true,
    mergeable_state: 'blocked',
    base: { ref: 'main', repo: { full_name: REPO, private: true } },
    requested_reviewers: [
      { ...PEOPLE.bob, avatar_url: avatar(2), type: 'User' },
      { id: 77, login: 'harbor-bot', avatar_url: 'https://tracker.example/x.png', type: 'Bot' },
    ],
    requested_teams: [{ slug: 'web', name: 'Web' }],
  };
  await send('pull_request', pullEvent('opened', { number: 31, sha: 'd00d0031', extra }));
  assert.equal((await reviewSession('bob', 'bob-review-31', '31')).status, 200);

  const { review, pull, readAt } = await reviewed('bob', 'bob-review-31');
  assert.deepEqual(review, { repo: REPO, number: 31 });
  assert.ok(readAt);
  assert.equal(pull?.state, 'open');
  // The description as written: the web renders it as markdown, never its HTML.
  assert.equal(pull?.body, body);
  assert.equal(pull?.bodyTruncated, undefined);
  assert.deepEqual(pull?.authorProfile, { login: 'alice', avatarUrl: avatar(1) });
  assert.equal(pull?.createdAt, '2026-10-19T08:00:00.000Z');
  assert.deepEqual(
    [pull?.headSha, pull?.base, pull?.branch, pull?.mergeable, pull?.mergeState, pull?.commits],
    ['d00d0031', 'main', 'fix/31', true, 'blocked', 3],
  );
  assert.deepEqual(pull?.labels, [{ name: 'bug', color: 'd73a4a' }]);
  assert.deepEqual(pull?.milestone, {
    title: 'October',
    number: 4,
    url: `https://github.com/${REPO}/milestone/4`,
    dueOn: '2026-10-31T07:00:00.000Z',
  });
  assert.deepEqual(
    pull?.closes?.map((i) => `${i.repo}#${i.number}`),
    [`${REPO}#12`, 'harbor-labs/atlas-api#3'],
  );
  // An avatar from anywhere but GitHub's image host is left out.
  assert.deepEqual(pull?.requestedReviewers, [
    { login: 'bob', avatarUrl: avatar(2) },
    { login: 'harbor-bot', bot: true },
  ]);
  assert.deepEqual(pull?.requestedTeams, [{ slug: 'web', name: 'Web' }]);
  assert.equal(pull?.reviews?.length ?? 0, 0);

  // The lists carry the same details, but not the description.
  const listed = (await lists('bob')).reviewRequested.find((p) => p.number === 31);
  assert.deepEqual([listed?.body, listed?.labels?.length], [undefined, 1]);

  // Bob reviews: his review is listed, he's no longer asked, and the details stay.
  await send(
    'pull_request_review',
    reviewEvent('submitted', PEOPLE.bob, 'approved', { number: 31, sha: 'd00d0031' }),
  );
  const after = (await reviewed('bob', 'bob-review-31')).pull;
  assert.deepEqual(
    after?.reviews?.map((r) => [r.by.login, r.state, !!r.submittedAt, !!r.url]),
    [['bob', 'approved', true, true]],
  );
  assert.deepEqual(after?.requestedReviewers, []);
  assert.deepEqual([after?.body, after?.labels?.length, after?.commits], [body, 1, 3]);
  assert.equal(after?.review, 'Approved');
});

test("a review session doesn't show a private pull request its person isn't on", async () => {
  const extra = { base: { ref: 'main', repo: { full_name: REPO, private: true } } };
  await send('pull_request', pullEvent('opened', { number: 32, sha: 'd00d0032', extra }));
  await reviewSession('dana', 'dana-review-32', '32');
  assert.equal((await reviewed('dana', 'dana-review-32')).pull, undefined);
  // Alice wrote it: hers to see.
  await reviewSession('alice', 'alice-review-32', '32');
  assert.equal((await reviewed('alice', 'alice-review-32')).pull?.number, 32);
});

test('a reviewed pull request no event brought is read from GitHub once', async () => {
  const extra = { base: { ref: 'main', repo: { full_name: REPO, private: false } } };
  answers.set(
    `/repos/harbor-labs/Atlas-Web/pulls/33`,
    pull({ number: 33, author: PEOPLE.bob, sha: 'd00d0033', extra }),
  );
  await reviewSession('dana', 'dana-review-33', 'https://github.com/harbor-labs/Atlas-Web/pull/33');
  const { review, pull: read } = await reviewed('dana', 'dana-review-33');
  assert.deepEqual([review.repo, review.number], ['harbor-labs/Atlas-Web', 33]);
  assert.deepEqual([read?.repo, read?.number, read?.headSha], [REPO, 33, 'd00d0033']);
  // Not a review session: nothing to show.
  await reviewSession('dana', 'dana-plain', '');
  assert.equal((await get('dana', '/api/sessions/dana-plain/review')).status, 404);
});

const changesOf = async (who: Who, sessionId: string) => {
  const res = await get(who, `/api/sessions/${sessionId}/changes`);
  assert.equal(res.status, 200);
  return SessionChanges.parse(await res.json());
};

const filesPage = (number: number, page = 1) =>
  `/repos/${REPO}/pulls/${number}/files?per_page=100&page=${page}`;

test("a review session's Changes are its pull request's files, read once per head", async () => {
  const extra = { base: { ref: 'main', repo: { full_name: REPO, private: false } } };
  await send('pull_request', pullEvent('opened', { number: 34, sha: 'd00d0034', extra }));
  answers.set(filesPage(34), [
    {
      filename: 'src/auth/redirect.ts',
      status: 'modified',
      additions: 2,
      deletions: 1,
      patch:
        '@@ -1,3 +1,4 @@\n import { next } from "./next";\n-redirect("/");\n+redirect(next());\n+log("signed in");',
    },
    {
      filename: 'src/auth/session.ts',
      previous_filename: 'src/session.ts',
      status: 'renamed',
      additions: 0,
      deletions: 0,
    },
    { filename: 'public/logo.png', status: 'added', additions: 0, deletions: 0 },
  ]);
  await reviewSession('bob', 'bob-review-34', '34');
  // Bob's folder has another branch checked out; its diff isn't what he reviews.
  await app.request('/api/changes', {
    method: 'POST',
    headers: { authorization: `Bearer ${tokens.get('bob')}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: 'bob-review-34',
      at: Date.now(),
      base: 'origin/main',
      diff: 'diff --git a/other.ts b/other.ts\n',
      truncated: false,
    }),
  });

  asked.length = 0;
  const changes = await changesOf('bob', 'bob-review-34');
  assert.equal(changes.source, 'pull');
  if (changes.source !== 'pull') return;
  assert.deepEqual(
    [changes.repo, changes.number, changes.base, changes.headSha, changes.truncated],
    [REPO, 34, 'main', 'd00d0034', false],
  );
  assert.deepEqual(
    changes.files.map((f) => [f.path, f.oldPath, f.status, f.additions, f.deletions, !!f.patch]),
    [
      ['src/auth/redirect.ts', undefined, 'modified', 2, 1, true],
      ['src/auth/session.ts', 'src/session.ts', 'renamed', 0, 0, false],
      ['public/logo.png', undefined, 'added', 0, 0, false],
    ],
  );
  assert.deepEqual(asked, [filesPage(34)]);

  // Asked again at the same head: kept, not read again.
  await changesOf('bob', 'bob-review-34');
  assert.deepEqual(asked, [filesPage(34)]);

  // A push moves the head: read afresh.
  answers.set(filesPage(34), [
    { filename: 'src/auth/redirect.ts', status: 'modified', additions: 1, deletions: 1 },
  ]);
  await send('pull_request', pullEvent('synchronize', { number: 34, sha: 'd00d0035', extra }));
  const pushed = await changesOf('bob', 'bob-review-34');
  assert.deepEqual(pushed.source === 'pull' && [pushed.headSha, pushed.files.length], [
    'd00d0035',
    1,
  ]);
  // (The lists' own read of its first files, without patches, aside.)
  assert.deepEqual(
    asked.filter((p) => p.includes('&page=')),
    [filesPage(34), filesPage(34)],
  );
});

test("a review session's Changes say why its pull request's diff can't be read", async () => {
  // A private pull request Dana isn't on: not hers to see, so no diff, and not her folder's.
  const extra = { base: { ref: 'main', repo: { full_name: REPO, private: true } } };
  await send('pull_request', pullEvent('opened', { number: 35, sha: 'd00d0036', extra }));
  await reviewSession('dana', 'dana-review-35', '35');
  assert.deepEqual(await changesOf('dana', 'dana-review-35'), {
    source: 'unavailable',
    repo: REPO,
    number: 35,
    reason: 'not-reached',
  });
  // Alice wrote it, but GitHub doesn't answer: unreadable, and not asked again straight away.
  await reviewSession('alice', 'alice-review-35', '35');
  asked.length = 0;
  const failed = await changesOf('alice', 'alice-review-35');
  assert.equal(failed.source === 'unavailable' && failed.reason, 'unreadable');
  await changesOf('alice', 'alice-review-35');
  assert.deepEqual(asked, [filesPage(35)]);
});

test('uninstalling hands GitHub back to the plugins', async () => {
  await send('installation', installationEvent('deleted'));
  assert.equal((await get('alice', '/api/sessions')).headers.get('x-joc-github'), null);
  const report = {
    at: Date.now(),
    status: 'ok',
    reviewRequested: [],
    mine: [
      {
        number: 99,
        title: 'Read by the plugin again',
        url: `https://github.com/${REPO}/pull/99`,
        repo: REPO,
        branch: 'fix/99',
        author: 'alice',
        updatedAt: new Date().toISOString(),
        draft: false,
        additions: 1,
        deletions: 1,
        ci: 'pass',
      },
    ],
  };
  const res = await app.request('/api/github', {
    method: 'POST',
    headers: { authorization: `Bearer ${tokens.get('alice')}`, 'content-type': 'application/json' },
    body: JSON.stringify(report),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(
    (await lists('alice')).mine.map((p) => p.number),
    [99],
  );
});

test('mentions are logins outside code, not emails or teams', () => {
  assert.deepEqual(
    mentions(
      'Thanks @Alice and @bob-2! See `@carol` and\n```\n@dana\n```\nmail x@harbor.test @harbor-labs/web',
    ),
    ['alice', 'bob-2'],
  );
});

test("the App's token request is a JWT signed with its key", () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  for (const raw of [pem, pem.replace(/\n/g, '\\n'), Buffer.from(pem).toString('base64')]) {
    const key = parsePrivateKey(raw);
    const jwt = appJwt('123', key, Date.parse('2026-10-20T09:00:00Z'));
    const [header, payload, signature] = jwt.split('.');
    const verify = createVerify('RSA-SHA256');
    verify.update(`${header}.${payload}`);
    assert.equal(
      verify.verify(createPublicKey(key), Buffer.from(signature ?? '', 'base64url')),
      true,
    );
    const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString());
    assert.deepEqual([claims.iss, claims.exp - claims.iat], ['123', 600]);
  }
});

// The GitHub App's webhooks, end to end: signed fixture deliveries into the app, against an
// in-memory MongoDB replica set, and what each person then sees.
import assert from 'node:assert/strict';
import { createHmac, createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import { after, before, test } from 'node:test';
import { closeClient } from '@joc/db';
import { Alert, GitHubSnapshot } from '@joc/protocol';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
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

const SECRET = 'webhook-test-secret';

/** A stand-in for GitHub's API, as the App reads it: by path. */
const answers = new Map<string, unknown>();
const api: GitHubAppApi = {
  get: async (_installation, path) => answers.get(path),
  about: async () => ({ slug: 'joc-dashboard', name: 'JOC Dashboard' }),
};
const webhooks = createWebhooks(SECRET, { api });
const github: GitHubAuth = {
  authorizeUrl: () => 'https://github.example/authorize',
  profileFor: async () => undefined,
};
const app = createApp({ github, publicUrl: 'http://joc.test', pluginVersion: '1.0.0', webhooks });

let mongo: MongoMemoryReplSet;
type Who = keyof typeof PEOPLE;
const tokens = new Map<Who, string>();
const owners = new Map<Who, Owner>();

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGODB_URI = mongo.getUri();
  process.env.MONGODB_DB = 'joc_webhook_test';
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
  await mongo.stop();
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

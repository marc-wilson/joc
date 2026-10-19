// Cross-user isolation: two owners share one server and database, and neither may read, change
// or hear about the other's data through any route. Runs against an in-memory MongoDB.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { closeClient, getDb } from '@joc/db';
import { ConversationItem, GitHubSnapshot, HistorySession, Session } from '@joc/protocol';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { z } from 'zod';
import { createApp } from './app.ts';
import type { GitHubAuth } from './github.ts';
import { createDeviceToken, signInGitHubUser } from './identity.ts';

type Who = 'alice' | 'bob';

let mongo: MongoMemoryServer;
const tokens = new Map<Who, string>();

before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  process.env.MONGODB_DB = 'joc_isolation_test';
  // Real identities: two GitHub users, each with one linked machine.
  for (const [who, id] of [
    ['alice', 1],
    ['bob', 2],
  ] as const) {
    const owner = await signInGitHubUser({ id, login: who });
    tokens.set(who, await createDeviceToken(owner, `${who}-laptop`));
  }
});

after(async () => {
  await closeClient();
  await mongo.stop();
});

const github: GitHubAuth = {
  authorizeUrl: () => 'https://github.example/authorize',
  profileFor: async () => undefined,
};
const app = createApp({ github, publicUrl: 'http://joc.test' });

const Sessions = z.array(Session);
const Items = z.array(ConversationItem);
const Claimed = z.object({ prompts: z.array(z.object({ id: z.string(), text: z.string() })) });

const read = async <T>(res: Response, schema: z.ZodType<T>): Promise<T> =>
  schema.parse(await res.json());

const auth = (who: Who) => ({ authorization: `Bearer ${tokens.get(who)}` });

function call(who: Who, path: string, body?: unknown) {
  return app.request(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...auth(who), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

let clock = Date.now();
const report = (sessionId: string, extra: Record<string, unknown> = {}) => ({
  sessionId,
  at: ++clock,
  state: 'working',
  repo: 'harbor-labs/atlas-web',
  ...extra,
});

test('every API route needs an owner', async () => {
  for (const [method, path] of [
    ['GET', '/api/sessions'],
    ['GET', '/api/stream'],
    ['GET', '/api/sessions/s/messages'],
    ['GET', '/api/sessions/s/changes'],
    ['POST', '/api/reports'],
    ['POST', '/api/messages'],
    ['POST', '/api/changes'],
    ['POST', '/api/sessions/s/prompts'],
    ['POST', '/api/sessions/s/prompts/claim'],
    ['GET', '/api/history'],
    ['GET', '/api/github'],
    ['POST', '/api/github'],
  ] as const) {
    const res = await app.request(path, { method });
    assert.equal(res.status, 401, `${method} ${path}`);
  }
});

test('sessions are listed only for their owner, even with the same session id', async () => {
  assert.equal(
    (await call('alice', '/api/reports', report('shared-id', { title: 'Alice' }))).status,
    200,
  );
  // Bob reports the same session id, later and with a title, trying to overwrite Alice's.
  const bobs = report('shared-id', { title: 'Bob', state: 'needs', activity: 'Bob was here' });
  assert.equal((await call('bob', '/api/reports', bobs)).status, 200);

  const alice = await read(await call('alice', '/api/sessions'), Sessions);
  const bob = await read(await call('bob', '/api/sessions'), Sessions);
  assert.deepEqual(
    alice.map((s) => [s.id, s.title, s.state]),
    [['shared-id', 'Alice', 'working']],
  );
  assert.deepEqual(
    bob.map((s) => [s.id, s.title, s.state]),
    [['shared-id', 'Bob', 'needs']],
  );
});

test('conversations stay with their owner', async () => {
  const item = { id: 'm1', at: new Date().toISOString(), kind: 'user', text: 'Alice only' };
  await call('alice', '/api/messages', { sessionId: 'shared-id', items: [item] });
  // Bob sends an item with the same id for the same session id.
  await call('bob', '/api/messages', {
    sessionId: 'shared-id',
    items: [{ ...item, text: 'Bob only' }],
  });

  const alice = await read(await call('alice', '/api/sessions/shared-id/messages'), Items);
  const bob = await read(await call('bob', '/api/sessions/shared-id/messages'), Items);
  assert.deepEqual(
    alice.map((i) => ('text' in i ? i.text : '')),
    ['Alice only'],
  );
  assert.deepEqual(
    bob.map((i) => ('text' in i ? i.text : '')),
    ['Bob only'],
  );
});

test('diffs stay with their owner', async () => {
  await call('alice', '/api/changes', {
    sessionId: 'alice-diff',
    at: ++clock,
    base: 'HEAD',
    diff: 'diff --git a/x b/x\n',
    truncated: false,
  });
  assert.equal((await call('alice', '/api/sessions/alice-diff/changes')).status, 200);
  assert.equal((await call('bob', '/api/sessions/alice-diff/changes')).status, 404);
});

test("prompts reach only their owner's plugin", async () => {
  await call('alice', '/api/sessions/shared-id/prompts', { text: 'For Alice' });
  await call('bob', '/api/sessions/shared-id/prompts', { text: 'For Bob' });

  const bob = await read(await call('bob', '/api/sessions/shared-id/prompts/claim', {}), Claimed);
  const alice = await read(
    await call('alice', '/api/sessions/shared-id/prompts/claim', {}),
    Claimed,
  );
  assert.deepEqual(
    bob.prompts.map((p) => p.text),
    ['For Bob'],
  );
  assert.deepEqual(
    alice.prompts.map((p) => p.text),
    ['For Alice'],
  );
});

/** Reads a server-sent event stream for `ms`, while `during` runs. */
async function listen(who: Who, during: () => Promise<void>, ms = 600): Promise<string> {
  const controller = new AbortController();
  const res = await app.request('/api/stream', { headers: auth(who), signal: controller.signal });
  assert.equal(res.status, 200);
  const reader = res.body?.getReader();
  assert.ok(reader);
  const decoder = new TextDecoder();
  let text = '';
  const reading = (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return;
      text += decoder.decode(value);
    }
  })();
  await during();
  await new Promise((r) => setTimeout(r, ms));
  controller.abort();
  await reader.cancel().catch(() => {});
  await reading;
  return text;
}

test("a live stream hears only its owner's updates", async () => {
  const heard = await listen('alice', async () => {
    await call('bob', '/api/reports', report('bob-live', { title: 'Bob secret' }));
    await call('bob', '/api/messages', {
      sessionId: 'bob-live',
      items: [{ id: 'b1', at: new Date().toISOString(), kind: 'user', text: 'Bob secret text' }],
    });
    await call('bob', '/api/changes', {
      sessionId: 'bob-live',
      at: ++clock,
      base: 'HEAD',
      diff: '',
      truncated: false,
    });
    await call('alice', '/api/reports', report('alice-live', { title: 'Alice update' }));
  });
  assert.match(heard, /event: snapshot/);
  assert.match(heard, /Alice update/);
  assert.doesNotMatch(heard, /bob-live|Bob secret/);
});

const pr = (title: string) => ({
  number: 7,
  title,
  url: 'https://github.example/harbor-labs/atlas-web/pull/7',
  repo: 'harbor-labs/atlas-web',
  branch: 'fix/auth-redirect',
  author: 'alice',
  updatedAt: new Date().toISOString(),
  draft: false,
  additions: 3,
  deletions: 1,
  ci: 'pass',
});

test('GitHub data stays with its owner', async () => {
  const report = { at: ++clock, status: 'ok', reviewRequested: [], mine: [pr('Alice PR')] };
  assert.equal((await call('alice', '/api/github', report)).status, 200);
  const alice = await read(await call('alice', '/api/github'), GitHubSnapshot);
  const bob = await read(await call('bob', '/api/github'), GitHubSnapshot);
  assert.deepEqual(alice.state === 'reported' && alice.mine.map((p) => p.title), ['Alice PR']);
  assert.equal(bob.state, 'none');
});

test('history is per owner, and a silent session leaves the live list but stays in history', async () => {
  await call('alice', '/api/reports', report('alice-old', { title: 'Old one' }));
  // An hour and a bit of silence.
  await getDb()
    .collection('sessions')
    .updateOne(
      { owner: 'gh_1', sessionId: 'alice-old' },
      { $set: { updatedAt: new Date(Date.now() - 61 * 60_000) } },
    );

  const live = await read(await call('alice', '/api/sessions'), Sessions);
  const history = await read(await call('alice', '/api/history'), z.array(HistorySession));
  const bobs = await read(await call('bob', '/api/history'), z.array(HistorySession));
  assert.equal(
    live.some((s) => s.id === 'alice-old'),
    false,
  );
  assert.equal(
    history.some((s) => s.id === 'alice-old'),
    true,
  );
  assert.equal(history.find((s) => s.id === 'shared-id')?.messages, 1);
  assert.equal(
    bobs.some((s) => s.title === 'Old one' || s.title === 'Alice'),
    false,
  );
});

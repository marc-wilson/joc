// Cross-user isolation: two owners share one server and database, and neither may read, change
// or hear about the other's data through any route. Runs against an in-memory MongoDB.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { closeClient, getDb } from '@joc/db';
import {
  Alert,
  AnswerRefused,
  ClaimedAnswer,
  ClaimedDeletes,
  ClaimedLaunch,
  ClaimedPrompt,
  ConversationItem,
  DeleteRefused,
  Deletion,
  Device,
  GitHubSnapshot,
  HistorySession,
  ImageRef,
  Launch,
  MachineProblem,
  NotificationsSnapshot,
  Prefs,
  PrefsSnapshot,
  ReadsClaim,
  ReviewSettings,
  Session,
  SessionCommands,
  SessionSettings,
} from '@joc/protocol';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { z } from 'zod';
import { createApp } from './app.ts';
import { claimDeletes, DELETE_WAIT_MS, listDeletes, requestDeletes } from './deletes.ts';
import type { GitHubAuth } from './github.ts';
import { createDeviceToken, createWebSession, signInGitHubUser } from './identity.ts';
import type { Owner } from './owner.ts';

type Who = 'alice' | 'bob';

let mongo: MongoMemoryServer;
const tokens = new Map<Who, string>();
/** Each person's browser session, for the routes only a signed-in person may use. */
const cookies = new Map<Who, string>();
const owners = new Map<Who, Owner>();

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
    owners.set(who, owner);
    tokens.set(who, await createDeviceToken(owner, `${who}-laptop`));
    cookies.set(who, `joc_session=${await createWebSession(owner)}`);
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
const app = createApp({ github, publicUrl: 'http://joc.test', pluginVersion: '1.0.0' });

const Sessions = z.array(Session);
const Items = z.array(ConversationItem);
const Claimed = z.object({ prompts: z.array(ClaimedPrompt) });

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
    ['GET', '/api/sessions/s/tasks/t/messages'],
    ['GET', '/api/sessions/s/changes'],
    ['GET', '/api/sessions/s/commands'],
    ['POST', '/api/reports'],
    ['POST', '/api/messages'],
    ['POST', '/api/changes'],
    ['POST', '/api/commands'],
    ['POST', '/api/sessions/s/prompts'],
    ['POST', '/api/sessions/s/prompts/claim'],
    ['GET', '/api/history'],
    ['GET', '/api/github'],
    ['POST', '/api/github'],
    ['GET', '/api/problems'],
    ['GET', '/api/version'],
    ['POST', '/api/problems'],
    ['POST', '/api/images'],
    ['GET', `/api/images/${'0'.repeat(64)}`],
    ['GET', '/api/notifications'],
    ['POST', '/api/notifications'],
    ['POST', '/api/notifications/read'],
    ['POST', '/api/notifications/read-all'],
    ['POST', '/api/notifications/reads/claim'],
    ['GET', '/api/settings/sessions'],
    ['PUT', '/api/settings/sessions'],
    ['GET', '/api/prefs'],
    ['PATCH', '/api/prefs'],
    ['GET', '/api/alerts'],
    ['POST', '/api/alerts/read'],
    ['POST', '/api/alerts/read-all'],
    ['POST', '/api/alerts/clear'],
    ['POST', '/api/alerts/clear-all'],
    ['GET', '/api/launches'],
    ['GET', '/api/launches?repo=harbor-labs/atlas-web&number=7'],
    ['POST', '/api/launches'],
    ['GET', '/api/settings/review'],
    ['PUT', '/api/settings/review'],
    ['POST', '/api/sessions/s/launches/claim'],
    ['POST', '/api/launches/l/result'],
    ['POST', '/api/sessions/s/waiting'],
    ['POST', '/api/sessions/s/waiting/w/done'],
    ['POST', '/api/sessions/s/answers'],
    ['POST', '/api/sessions/s/answers/claim'],
    ['GET', '/api/deletes'],
    ['POST', '/api/deletes'],
    ['POST', '/api/deletes/claim'],
    ['POST', '/api/deletes/d/result'],
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

test("a session's background list is its owner's, and stays until a report brings a new one", async () => {
  const shell = { id: 'b7k2m9', type: 'shell', command: 'pnpm dev' };
  await call(
    'alice',
    '/api/reports',
    report('bg-id', { state: 'background', background: [shell] }),
  );
  await call('bob', '/api/reports', report('bg-id', { state: 'idle', background: [] }));
  // A later report without a list (a tool call, a sync) keeps the one stored.
  await call('alice', '/api/reports', report('bg-id', { activity: 'pnpm test' }));
  const alice = (await read(await call('alice', '/api/sessions'), Sessions)).find(
    (s) => s.id === 'bg-id',
  );
  const bob = (await read(await call('bob', '/api/sessions'), Sessions)).find(
    (s) => s.id === 'bg-id',
  );
  assert.deepEqual(alice?.background?.tasks, [shell]);
  assert.deepEqual(bob?.background?.tasks, []);
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

test("a subagent's steps stay with their owner and out of the conversation", async () => {
  const step = {
    id: 'step-1',
    at: new Date().toISOString(),
    kind: 'claude',
    text: 'Alice subagent',
    task: 'toolu_1',
  };
  await call('alice', '/api/messages', { sessionId: 'task-id', items: [step] });
  await call('bob', '/api/messages', {
    sessionId: 'task-id',
    items: [{ ...step, text: 'Bob subagent' }],
  });

  const steps = async (who: Who) =>
    (await read(await call(who, '/api/sessions/task-id/tasks/toolu_1/messages'), Items)).map((i) =>
      'text' in i ? i.text : '',
    );
  assert.deepEqual(await steps('alice'), ['Alice subagent']);
  assert.deepEqual(await steps('bob'), ['Bob subagent']);
  // Neither shows in the session's own conversation.
  assert.deepEqual(await read(await call('alice', '/api/sessions/task-id/messages'), Items), []);
  assert.deepEqual(await read(await call('bob', '/api/sessions/task-id/messages'), Items), []);
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

test('slash commands stay with their owner', async () => {
  const commands = (name: string) => [
    { name, description: 'Review a pull request', argumentHint: '<pr>', source: 'project' },
  ];
  const listOf = async (who: Who, id: string) =>
    (await read(await call(who, `/api/sessions/${id}/commands`), SessionCommands)).commands.map(
      (c) => c.name,
    );
  const sent = { sessionId: 'shared-cmds', at: ++clock };
  assert.equal(
    (await call('alice', '/api/commands', { ...sent, commands: commands('alice-review') })).status,
    200,
  );
  assert.equal(
    (await call('bob', '/api/commands', { ...sent, commands: commands('bob-review') })).status,
    200,
  );
  assert.deepEqual(await listOf('alice', 'shared-cmds'), ['alice-review']);
  assert.deepEqual(await listOf('bob', 'shared-cmds'), ['bob-review']);
  assert.equal((await call('bob', '/api/sessions/alice-only-cmds/commands')).status, 404);
  // An older list than the stored one is dropped.
  const stale = { sessionId: 'shared-cmds', at: sent.at - 1, commands: commands('old') };
  assert.equal((await call('alice', '/api/commands', stale)).status, 202);
  assert.deepEqual(await listOf('alice', 'shared-cmds'), ['alice-review']);
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
    await call('bob', '/api/notifications', {
      at: ++clock,
      status: 'ok',
      threads: [thread('9001', 'Bob secret thread')],
      more: false,
    });
    await call('alice', '/api/reports', report('alice-live', { title: 'Alice update' }));
  });
  assert.match(heard, /event: snapshot/);
  assert.match(heard, /Alice update/);
  assert.doesNotMatch(heard, /bob-live|Bob secret|event: notifications/);
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

/** Backdates a session's last report, as if it went quiet that long ago. */
const quietFor = (owner: string, sessionId: string, ms: number) =>
  getDb()
    .collection('sessions')
    .updateOne({ owner, sessionId }, { $set: { updatedAt: new Date(Date.now() - ms) } });

const DAY = 24 * 60 * 60_000;

test('history is per owner, and a silent session leaves the live list but stays in history', async () => {
  await call('alice', '/api/reports', report('alice-old', { title: 'Old one' }));
  // Over a week of silence, the default for a session that went quiet.
  await quietFor('gh_1', 'alice-old', 8 * DAY);

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

test("how long sessions stay is each owner's own setting, and only a signed-in person's", async () => {
  const asPerson = (who: Who, body?: unknown) =>
    app.request('/api/settings/sessions', {
      method: body === undefined ? 'GET' : 'PUT',
      headers: {
        cookie: cookies.get(who) ?? '',
        host: 'joc.test',
        origin: 'http://joc.test',
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const live = async (who: Who) =>
    (await read(await call(who, '/api/sessions'), Sessions)).map((s) => s.id);

  // Bob has a session that went quiet over a week ago too. Alice has one that ended 2h ago.
  await call('bob', '/api/reports', report('bob-old'));
  await quietFor('gh_2', 'bob-old', 8 * DAY);
  await call('alice', '/api/reports', report('alice-ended', { state: 'offline' }));
  await quietFor('gh_1', 'alice-ended', 2 * 60 * 60_000);
  assert.equal((await live('alice')).includes('alice-ended'), true);

  // Alice keeps quiet sessions for good, and ended ones for an hour.
  assert.equal((await asPerson('alice', { quiet: 'never', ended: '1h' })).status, 200);
  assert.deepEqual(await read(await asPerson('alice'), SessionSettings), {
    quiet: 'never',
    ended: '1h',
  });
  assert.equal((await live('alice')).includes('alice-old'), true);
  assert.equal((await live('alice')).includes('alice-ended'), false);

  // Bob still has the defaults, and his quiet session stays off his list.
  assert.deepEqual(await read(await asPerson('bob'), SessionSettings), {
    quiet: '1w',
    ended: '1d',
  });
  const bobs = await live('bob');
  assert.equal(bobs.includes('bob-old'), false);
  assert.equal(
    bobs.some((id) => id.startsWith('alice')),
    false,
  );

  // A machine's token can't read or change them, and a bad value is refused.
  assert.equal((await call('alice', '/api/settings/sessions')).status, 403);
  assert.equal((await asPerson('alice', { quiet: 'forever', ended: '1h' })).status, 400);

  await asPerson('alice', { quiet: '1w', ended: '1d' });
});

test("a machine's problems are shown only to its owner, and only to a signed-in person", async () => {
  const problem = {
    kind: 'rejected',
    where: '/api/messages',
    detail: 'HTTP 400: items.0.text: Invalid input',
    firstAt: clock,
    lastAt: clock,
    count: 2,
  };
  const sent = await call('alice', '/api/problems', {
    machine: 'alice-laptop',
    problems: [problem],
  });
  assert.equal(sent.status, 204);
  assert.equal((await call('alice', '/api/problems', { machine: 'x', problems: [] })).status, 400);
  // An older version of the same problem, arriving late, doesn't win.
  const older = { ...problem, lastAt: clock - 1, count: 1 };
  await call('alice', '/api/problems', { machine: 'alice-laptop', problems: [older] });

  const asPerson = (who: Who) =>
    app.request('/api/problems', { headers: { cookie: cookies.get(who) ?? '' } });
  const alice = await read(await asPerson('alice'), z.array(MachineProblem));
  const bob = await read(await asPerson('bob'), z.array(MachineProblem));
  assert.deepEqual(
    alice.map((p) => [p.machine, p.kind, p.where, p.count]),
    [['alice-laptop', 'rejected', '/api/messages', 2]],
  );
  assert.deepEqual(bob, []);
  // A machine's token reports problems but can't read them; a browser can't report them.
  assert.equal((await call('alice', '/api/problems')).status, 403);
  const fromBrowser = await app.request('/api/problems', {
    method: 'POST',
    headers: {
      cookie: cookies.get('alice') ?? '',
      host: 'joc.test',
      origin: 'http://joc.test',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ machine: 'alice-laptop', problems: [problem] }),
  });
  assert.equal(fromBrowser.status, 403);
});

test("a machine's plugin version is shown only to its owner, and an old plugin still works", async () => {
  const asPlugin = (who: Who, version: string) =>
    app.request('/api/sessions', { headers: { ...auth(who), 'x-joc-plugin': version } });
  // Behind the server's 1.0.0: answered as usual, with the version it should run.
  const old = await asPlugin('alice', '0.9.0');
  assert.equal(old.status, 200);
  assert.equal(old.headers.get('x-joc-plugin-latest'), '1.0.0');
  assert.equal((await asPlugin('bob', '1.0.0')).headers.get('x-joc-plugin-latest'), null);

  const machines = async (who: Who) =>
    read(
      await app.request('/api/devices', { headers: { cookie: cookies.get(who) ?? '' } }),
      z.array(Device),
    );
  assert.deepEqual(
    (await machines('alice')).map((d) => [d.name, d.plugin, d.outdated]),
    [['alice-laptop', '0.9.0', true]],
  );
  assert.deepEqual(
    (await machines('bob')).map((d) => [d.name, d.plugin, d.outdated]),
    [['bob-laptop', '1.0.0', false]],
  );
});

test("a machine's installed plugin and its sessions' old copies are shown only to their owner", async () => {
  const send = (who: Who, sessionId: string, headers: Record<string, string>, extra = {}) =>
    app.request('/api/reports', {
      method: 'POST',
      headers: { ...auth(who), 'content-type': 'application/json', ...headers },
      body: JSON.stringify(report(sessionId, extra)),
    });
  const machines = async (who: Who) =>
    read(
      await app.request('/api/devices', { headers: { cookie: cookies.get(who) ?? '' } }),
      z.array(Device),
    );
  const current = { 'x-joc-plugin': '1.0.0', 'x-joc-plugin-installed': '1.0.0' };

  // Alice updated: one session loaded the new copy, another still runs the old one.
  assert.equal((await send('alice', 'plugin-new', current)).status, 200);
  assert.equal((await send('alice', 'plugin-old', { 'x-joc-plugin': '0.9.0' })).status, 200);
  // Bob's session has the same id and runs an old copy too, with nothing installed said.
  assert.equal((await send('bob', 'plugin-old', { 'x-joc-plugin': '0.8.0' })).status, 200);

  const [alice] = await machines('alice');
  assert.equal(alice?.installed, '1.0.0');
  // The old session's request was the latest, but what's installed decides.
  assert.equal(alice?.plugin, '0.9.0');
  assert.equal(alice?.outdated, false);
  assert.deepEqual(
    alice?.stale.map((s) => [s.id, s.plugin]),
    [['plugin-old', '0.9.0']],
  );
  const [bob] = await machines('bob');
  assert.equal(bob?.installed, undefined);
  // Bob's plugin can't say what's installed: judged by its latest request, as before.
  assert.equal(bob?.outdated, true);
  assert.deepEqual(
    bob?.stale.map((s) => [s.id, s.plugin]),
    [['plugin-old', '0.8.0']],
  );

  // Each owner's sessions show the copy they run, and only to them.
  const plugins = async (who: Who) =>
    (await read(await call(who, '/api/sessions'), Sessions))
      .filter((s) => s.id.startsWith('plugin-'))
      .map((s) => [s.id, s.plugin]);
  assert.deepEqual(await plugins('alice'), [
    ['plugin-new', '1.0.0'],
    ['plugin-old', '0.9.0'],
  ]);
  assert.deepEqual(await plugins('bob'), [['plugin-old', '0.8.0']]);

  // An ended session no longer counts; an installed version that falls behind does.
  await send('alice', 'plugin-old', { 'x-joc-plugin': '0.9.0' }, { state: 'offline' });
  await send('alice', 'plugin-new', { 'x-joc-plugin': '1.0.0', 'x-joc-plugin-installed': '0.9.5' });
  const [after] = await machines('alice');
  assert.deepEqual(after?.stale, []);
  assert.equal(after?.installed, '0.9.5');
  assert.equal(after?.outdated, true);
  assert.equal((await machines('bob'))[0]?.stale.length, 1);
});

/** A tiny made-up PNG: the signature, then bytes of its own. */
const png = (fill: string) =>
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from(fill)]);

const upload = (who: Who, bytes: Uint8Array) =>
  app.request('/api/images', {
    method: 'POST',
    headers: { ...auth(who), 'content-type': 'image/png' },
    body: bytes,
  });

test('images are served only to their owner', async () => {
  const alices = png('alice screenshot');
  const res = await upload('alice', alices);
  assert.equal(res.status, 201);
  const { id } = await read(res, ImageRef);

  const own = await call('alice', `/api/images/${id}`);
  assert.equal(own.status, 200);
  assert.deepEqual(new Uint8Array(await own.arrayBuffer()), alices);
  assert.equal((await call('bob', `/api/images/${id}`)).status, 404);
});

test("another owner can't overwrite an image or send it in a prompt", async () => {
  const alices = png('alice only');
  const { id } = await read(await upload('alice', alices), ImageRef);

  // Bob can't name an id to write to: the same bytes make his own copy, other bytes another id.
  const same = await read(await upload('bob', alices), ImageRef);
  assert.equal(same.id, id);
  const other = await read(await upload('bob', png('bob was here')), ImageRef);
  assert.notEqual(other.id, id);
  const alice = await call('alice', `/api/images/${id}`);
  assert.deepEqual(new Uint8Array(await alice.arrayBuffer()), alices);

  // Nor can he queue a prompt with an image of Alice's he never uploaded.
  const secret = await read(await upload('alice', png('alice secret')), ImageRef);
  const prompt = await call('bob', '/api/sessions/shared-id/prompts', {
    text: 'Look',
    images: [secret.id],
  });
  assert.equal(prompt.status, 400);
});

test("a prompt's images reach only their owner's plugin", async () => {
  const image = await read(await upload('alice', png('for the session')), ImageRef);
  const queued = await call('alice', '/api/sessions/img-session/prompts', {
    text: '',
    images: [image.id],
  });
  assert.equal(queued.status, 201);

  const bob = await read(await call('bob', '/api/sessions/img-session/prompts/claim', {}), Claimed);
  const alice = await read(
    await call('alice', '/api/sessions/img-session/prompts/claim', {}),
    Claimed,
  );
  assert.deepEqual(bob.prompts, []);
  assert.deepEqual(
    alice.prompts.map((p) => p.images),
    [[image]],
  );
});

test("slash commands stay with their owner, and a command's output isn't counted", async () => {
  await call('alice', '/api/reports', report('alice-cmd', { title: 'Commands' }));
  const at = new Date().toISOString();
  const items = [
    { id: 'c1', at, kind: 'command', name: 'cost', args: '' },
    { id: 'c2', at, kind: 'command_output', commandId: 'c1', text: 'Total: $0.42', isError: false },
  ];
  assert.equal(
    (await call('alice', '/api/messages', { sessionId: 'alice-cmd', items })).status,
    200,
  );

  const alice = await read(await call('alice', '/api/sessions/alice-cmd/messages'), Items);
  const bob = await read(await call('bob', '/api/sessions/alice-cmd/messages'), Items);
  assert.deepEqual(
    alice.map((i) => i.kind),
    ['command', 'command_output'],
  );
  assert.deepEqual(bob, []);
  const history = await read(await call('alice', '/api/history'), z.array(HistorySession));
  assert.equal(history.find((s) => s.id === 'alice-cmd')?.messages, 1);
});

function thread(id: string, title: string, updatedAt = new Date().toISOString()) {
  return {
    id,
    reason: 'review_requested',
    title,
    type: 'PullRequest',
    repo: 'harbor-labs/atlas-web',
    url: `https://github.com/harbor-labs/atlas-web/pull/${id}`,
    updatedAt,
    number: Number(id),
    alert: 'review',
  };
}

const unread = async (who: Who) => {
  const snapshot = await read(await call(who, '/api/notifications'), NotificationsSnapshot);
  return snapshot.state === 'reported' ? snapshot.threads.map((t) => t.title) : 'none';
};
const claim = async (who: Who) =>
  (await read(await call(who, '/api/notifications/reads/claim', {}), ReadsClaim)).ids;

test('notifications stay with their owner', async () => {
  const sent = { at: ++clock, status: 'ok', threads: [thread('101', 'Alice thread')], more: false };
  assert.equal((await call('alice', '/api/notifications', sent)).status, 200);
  assert.deepEqual(await unread('alice'), ['Alice thread']);
  // Bob's own, from the live stream test, and never Alice's.
  assert.deepEqual(await unread('bob'), ['Bob secret thread']);
});

test("marking read reaches only the owner's machines, and hides only the owner's thread", async () => {
  const at = ++clock;
  await call('alice', '/api/notifications', {
    at,
    status: 'ok',
    threads: [thread('201', 'Alice one'), thread('202', 'Alice two')],
    more: false,
  });
  await call('bob', '/api/notifications', {
    at,
    status: 'ok',
    threads: [thread('201', 'Bob one')],
    more: false,
  });

  // Bob marks the same thread id read, and then everything he has.
  assert.equal((await call('bob', '/api/notifications/read', { ids: ['201'] })).status, 204);
  assert.equal((await call('bob', '/api/notifications/read-all', {})).status, 204);
  assert.deepEqual(await unread('bob'), []);
  assert.deepEqual(await unread('alice'), ['Alice one', 'Alice two']);
  assert.deepEqual(await claim('alice'), []);
  assert.deepEqual(await claim('bob'), ['201']);

  assert.equal((await call('alice', '/api/notifications/read', { ids: ['202'] })).status, 204);
  assert.deepEqual(await unread('alice'), ['Alice one']);
  assert.deepEqual(await claim('bob'), []);
  assert.deepEqual(await claim('alice'), ['202']);
  // Claimed once: the next machine to read finds nothing left.
  assert.deepEqual(await claim('alice'), []);
});

test('a thread marked read comes back when something new happens on it', async () => {
  const earlier = new Date(Date.now() - 60_000).toISOString();
  await call('alice', '/api/notifications/read', { ids: ['301'] });
  const later = new Date(Date.now() + 60_000).toISOString();
  await call('alice', '/api/notifications', {
    at: ++clock,
    status: 'ok',
    threads: [thread('301', 'Quiet since', earlier), thread('302', 'New comment', later)],
    more: false,
  });
  await call('alice', '/api/notifications/read', { ids: ['302'] });
  await call('alice', '/api/notifications', {
    at: ++clock,
    status: 'ok',
    threads: [
      thread('301', 'Quiet since', earlier),
      thread('302', 'New comment', new Date(Date.now() + 120_000).toISOString()),
    ],
    more: false,
  });
  assert.deepEqual(await unread('alice'), ['New comment']);
});

test('only a machine takes the mark-read queue, and bad ids are refused', async () => {
  const res = await app.request('/api/notifications/reads/claim', {
    method: 'POST',
    headers: { cookie: cookies.get('alice') ?? '', host: 'joc.test', origin: 'http://joc.test' },
  });
  assert.equal(res.status, 403);
  assert.equal((await call('alice', '/api/notifications/read', { ids: ['../x'] })).status, 400);
  assert.equal((await call('alice', '/api/notifications/read', { ids: [] })).status, 400);
});

const Alerts = z.array(Alert);
const alertsOf = async (who: Who) => read(await call(who, '/api/alerts'), Alerts);
const kinds = async (who: Who, sessionId: string) =>
  (await alertsOf(who)).filter((a) => a.sessionId === sessionId).map((a) => [a.kind, a.read]);

test("a session's alerts are raised, read and cleared only for its owner", async () => {
  // Bob's own from earlier tests go first, so what's left is what this test raises.
  await call('bob', '/api/alerts/clear-all', {});
  const heard = await listen('alice', async () => {
    await call('bob', '/api/reports', report('alerts-id'));
    await call('bob', '/api/reports', report('alerts-id', { state: 'needs', activity: 'Bob q' }));
  });
  assert.doesNotMatch(heard, /event: alerts/);

  await call('alice', '/api/reports', report('alerts-id', { title: 'Alice asks' }));
  await call('alice', '/api/reports', report('alerts-id', { state: 'needs' }));
  // A sync (no state) changes nothing.
  await call('alice', '/api/reports', report('alerts-id', { state: undefined }));
  assert.deepEqual(await kinds('alice', 'alerts-id'), [['needs', false]]);
  assert.deepEqual(await kinds('bob', 'alerts-id'), [['needs', false]]);
  const [alices] = await alertsOf('alice');
  assert.ok(alices);
  assert.equal(alices.title, 'Alice asks');

  // Bob can't read or clear Alice's alert by its id, nor through his own "all".
  assert.equal((await call('bob', '/api/alerts/read', { ids: [alices.id] })).status, 204);
  assert.equal((await call('bob', '/api/alerts/clear', { ids: [alices.id] })).status, 204);
  await call('bob', '/api/alerts/read-all', {});
  assert.deepEqual(await kinds('alice', 'alerts-id'), [['needs', false]]);
  assert.deepEqual(await kinds('bob', 'alerts-id'), [['needs', true]]);
  await call('bob', '/api/alerts/clear-all', {});
  assert.deepEqual(await alertsOf('bob'), []);

  // Answered: Alice's session leaves `needs`, so its alert reads; the turn's end is news.
  await call('alice', '/api/reports', report('alerts-id'));
  await call('alice', '/api/reports', report('alerts-id', { state: 'idle', activity: 'Done' }));
  assert.deepEqual(await kinds('alice', 'alerts-id'), [
    ['finished', false],
    ['needs', true],
  ]);
  const [finished] = await alertsOf('alice');
  assert.equal((await call('alice', '/api/alerts/read', { ids: [finished?.id] })).status, 204);
  assert.equal((await call('alice', '/api/alerts/clear', { ids: [alices.id] })).status, 204);
  assert.deepEqual(await kinds('alice', 'alerts-id'), [['finished', true]]);
  assert.deepEqual(await alertsOf('bob'), []);
});

test('review requests raise alerts only for their owner, and only once', async () => {
  const report = (reviewRequested: unknown[], status = 'ok') => ({
    at: ++clock,
    status,
    reviewRequested,
    mine: [],
  });
  await call('alice', '/api/alerts/clear-all', {});
  await call('bob', '/api/github', report([]));
  await call('bob', '/api/github', report([pr('Bob review')]));
  // What a read after a failed one finds is where she starts, not news; after it, a new request is.
  await call('alice', '/api/github', report([], 'error'));
  await call('alice', '/api/github', report([pr('Already there')]));
  await call('alice', '/api/github', report([{ ...pr('Review me'), number: 8 }]));
  await call('alice', '/api/github', report([{ ...pr('Review me'), number: 8 }]));
  // After gh failed, what comes back isn't news either.
  await call('alice', '/api/github', report([], 'signed-out'));
  await call('alice', '/api/github', report([{ ...pr('Back again'), number: 9 }]));
  assert.deepEqual(
    (await alertsOf('alice')).map((a) => [a.kind, a.title, a.number]),
    [['review', 'Review me', 8]],
  );
  assert.deepEqual(
    (await alertsOf('bob')).map((a) => a.title),
    ['Bob review'],
  );
});

test('alert ids are checked', async () => {
  assert.equal((await call('alice', '/api/alerts/read', { ids: ['../x'] })).status, 400);
  assert.equal((await call('alice', '/api/alerts/clear', { ids: [] })).status, 400);
  assert.equal((await call('alice', '/api/alerts/clear', {})).status, 400);
});

const Launches = z.array(Launch);
const Claims = z.object({ launches: z.array(ClaimedLaunch) });

const PR = {
  repo: 'harbor-labs/atlas-web',
  number: 7,
  url: 'https://github.com/harbor-labs/atlas-web/pull/7',
};
const launchesOf = async (who: Who, query = '') =>
  read(await call(who, `/api/launches${query}`), Launches);
const claimsFor = async (who: Who, sessionId: string) =>
  (await read(await call(who, `/api/sessions/${sessionId}/launches/claim`, {}), Claims)).launches;

test("a new session starts only from its owner's own live session", async () => {
  await call('alice', '/api/reports', report('alice-rev', { title: 'Reviewer' }));
  await call('alice', '/api/reports', report('alice-other', { repo: 'harbor-labs/tide' }));

  // Bob can't start one from Alice's session.
  assert.equal((await call('bob', '/api/launches', { from: 'alice-rev' })).status, 400);
  // Nor can Alice review a PR from a session on another repo.
  const elsewhere = { from: 'alice-other', review: PR };
  assert.equal((await call('alice', '/api/launches', elsewhere)).status, 400);

  const sent = await call('alice', '/api/launches', { from: 'alice-rev', prompt: 'Fix the tests' });
  assert.equal(sent.status, 201);
  const launch = await read(sent, Launch);
  assert.deepEqual(
    [launch.from, launch.status, launch.prompt, launch.repo],
    ['alice-rev', 'starting', 'Fix the tests', 'harbor-labs/atlas-web'],
  );
  assert.deepEqual(
    (await launchesOf('alice')).map((l) => l.id),
    [launch.id],
  );
  assert.deepEqual(await launchesOf('bob'), []);
});

test("a new session is started only by its owner's plugin, which alone says how it went", async () => {
  const launch = await read(await call('alice', '/api/launches', { from: 'alice-rev' }), Launch);

  // Bob's plugin, polling the same session id, gets nothing; a browser can't take launches.
  assert.deepEqual(await claimsFor('bob', 'alice-rev'), []);
  const fromBrowser = await app.request('/api/sessions/alice-rev/launches/claim', {
    method: 'POST',
    headers: { cookie: cookies.get('alice') ?? '', host: 'joc.test', origin: 'http://joc.test' },
  });
  assert.equal(fromBrowser.status, 403);

  // The earlier launch from the test above comes first; this one has no prompt.
  const claimed = await claimsFor('alice', 'alice-rev');
  assert.deepEqual(
    claimed.map((l) => [l.prompt, l.name]),
    [
      ['Fix the tests', undefined],
      [undefined, undefined],
    ],
  );
  assert.equal(claimed[1]?.id, launch.id);
  // Taken once.
  assert.deepEqual(await claimsFor('alice', 'alice-rev'), []);

  const started = '9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f';
  const result = (who: Who, body: unknown) => call(who, `/api/launches/${launch.id}/result`, body);
  assert.equal((await result('bob', { ok: false, detail: 'Bob was here' })).status, 404);
  assert.equal((await result('alice', { ok: true, sessionId: 'not-a-uuid' })).status, 400);
  assert.equal((await result('alice', { ok: true, sessionId: started })).status, 204);
  const after = (await launchesOf('alice')).find((l) => l.id === launch.id);
  assert.deepEqual([after?.status, after?.sessionId], ['started', started]);
});

test("a review runs the owner's own instructions, in a session on the PR's repo", async () => {
  const put = (who: Who, body: unknown) =>
    app.request('/api/settings/review', {
      method: 'PUT',
      headers: { ...auth(who), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  assert.equal((await put('alice', { instructions: '/prep-pr' })).status, 200);
  assert.equal((await put('alice', { instructions: 'x'.repeat(20_001) })).status, 400);
  assert.deepEqual(await read(await call('alice', '/api/settings/review'), ReviewSettings), {
    instructions: '/prep-pr',
  });
  assert.deepEqual(await read(await call('bob', '/api/settings/review'), ReviewSettings), {});

  // Bob reviews the same PR from his own session: Claude's review, not Alice's command.
  await call('bob', '/api/reports', report('bob-rev'));
  const alices = await read(
    await call('alice', '/api/launches', { from: 'alice-rev', review: PR }),
    Launch,
  );
  const bobs = await read(
    await call('bob', '/api/launches', { from: 'bob-rev', review: PR }),
    Launch,
  );
  assert.equal(alices.prompt, `/prep-pr ${PR.url}`);
  assert.equal(bobs.prompt, '/code-review 7');
  assert.deepEqual(
    (await claimsFor('alice', 'alice-rev')).map((l) => l.name),
    ['Review harbor-labs/atlas-web#7'],
  );

  // Each sees only their own reviews of the PR.
  const query = '?repo=harbor-labs/atlas-web&number=7';
  assert.deepEqual(
    (await launchesOf('alice', query)).map((l) => l.id),
    [alices.id],
  );
  assert.deepEqual(
    (await launchesOf('bob', query)).map((l) => l.id),
    [bobs.id],
  );

  // Clearing the instructions goes back to Claude's review.
  assert.equal((await put('alice', { instructions: '  ' })).status, 200);
  assert.deepEqual(await read(await call('alice', '/api/settings/review'), ReviewSettings), {});
});

test('a new session nobody started in time never starts, and says so', async () => {
  const launch = await read(await call('alice', '/api/launches', { from: 'alice-rev' }), Launch);
  await getDb()
    .collection('launches')
    .updateOne(
      { _id: launch.id as never },
      { $set: { createdAt: new Date(Date.now() - 11 * 60_000) } },
    );
  assert.deepEqual(await claimsFor('alice', 'alice-rev'), []);
  assert.equal((await launchesOf('alice')).find((l) => l.id === launch.id)?.status, 'failed');
});

test("a live stream hears only its owner's launches", async () => {
  const heard = await listen('alice', async () => {
    const res = await call('bob', '/api/launches', { from: 'bob-rev' });
    assert.equal(res.status, 201);
  });
  assert.doesNotMatch(heard, /event: launches/);
});

test("preferences are each owner's own, only a signed-in person's, and heard only by them", async () => {
  const asPerson = (who: Who, body?: unknown) =>
    app.request('/api/prefs', {
      method: body === undefined ? 'GET' : 'PATCH',
      headers: {
        cookie: cookies.get(who) ?? '',
        host: 'joc.test',
        origin: 'http://joc.test',
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  await call('alice', '/api/reports', report('alice-pref'));
  await call('bob', '/api/reports', report('bob-pref'));

  assert.deepEqual(await read(await asPerson('alice'), PrefsSnapshot), {
    saved: false,
    prefs: {
      browserNotifications: false,
      desktopWhenAway: true,
      notificationKinds: {},
      notificationTab: 'all',
      pinned: [],
      foldedGroups: [],
      listFolded: false,
      diffMode: 'unified',
      showAllFinishedTasks: false,
      sessions: [],
    },
  });

  // Alice turns notifications on and pins her session. Bob's open tab hears nothing of it.
  const heard = await listen('bob', async () => {
    const res = await asPerson('alice', {
      browserNotifications: true,
      notificationKinds: { github: { panel: false, toast: false, desktop: false } },
      // Bob's session id is no session of Alice's, so it's dropped.
      pinned: ['alice-pref', 'bob-pref'],
      sessions: [
        { id: 'alice-pref', foldedMessages: ['m1'] },
        { id: 'bob-pref', foldedMessages: ['m2'] },
      ],
    });
    assert.equal(res.status, 200);
  });
  assert.doesNotMatch(heard, /event: prefs/);

  const alice = await read(await asPerson('alice'), PrefsSnapshot);
  assert.equal(alice.saved, true);
  assert.equal(alice.prefs.browserNotifications, true);
  assert.deepEqual(alice.prefs.pinned, ['alice-pref']);
  assert.deepEqual(
    alice.prefs.sessions.map((s) => [s.id, s.foldedMessages]),
    [['alice-pref', ['m1']]],
  );
  assert.deepEqual(Object.keys(alice.prefs.notificationKinds), ['github']);
  const bob = await read(await asPerson('bob'), PrefsSnapshot);
  assert.equal(bob.saved, false);
  assert.equal(bob.prefs.browserNotifications, false);
  assert.deepEqual(bob.prefs.notificationKinds, {});

  // A patch keeps what it doesn't name, and Alice's other tabs hear the result.
  const own = await listen('alice', async () => {
    assert.equal((await asPerson('alice', { listFolded: true })).status, 200);
  });
  assert.match(own, /event: prefs/);
  const after = await read(await asPerson('alice'), PrefsSnapshot);
  assert.equal(after.prefs.listFolded, true);
  assert.equal(after.prefs.browserNotifications, true);
  assert.equal(Prefs.safeParse(after.prefs).success, true);

  // A machine's token can't read or change them, and a bad value is refused.
  assert.equal((await call('alice', '/api/prefs')).status, 403);
  const patched = await app.request('/api/prefs', {
    method: 'PATCH',
    headers: { ...auth('alice'), 'content-type': 'application/json' },
    body: JSON.stringify({ browserNotifications: false }),
  });
  assert.equal(patched.status, 403);
  assert.equal((await asPerson('alice', { diffMode: 'sideways' })).status, 400);
});

/** A POST from a person's signed-in browser. */
const fromBrowser = (who: Who, path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: {
      cookie: cookies.get(who) ?? '',
      host: 'joc.test',
      origin: 'http://joc.test',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

test("a session's waits are answered only by its owner, in a browser, and taken only by their plugin", async () => {
  const sessionOf = async (who: Who, id: string) =>
    (await read(await call(who, '/api/sessions'), Sessions)).find((s) => s.id === id);
  const claim = async (who: Who, id: string, waitingId: string, waitMs = 0) =>
    read(
      await call(who, `/api/sessions/${id}/answers/claim`, { waitingId, waitMs }),
      ClaimedAnswer,
    );
  const question = {
    kind: 'question',
    id: 'wait-alice-q1',
    questions: [
      {
        question: 'Which sender domain should I use?',
        options: [{ label: 'mail.atlas.dev' }, { label: 'atlas.dev' }],
        multiSelect: false,
      },
    ],
  };
  const answer = {
    kind: 'question',
    answers: { 'Which sender domain should I use?': 'atlas.dev' },
  };

  // The same session id for both; Alice's plugin says it waits on a question.
  await call('alice', '/api/reports', report('shared-wait', { state: 'needs' }));
  await call('bob', '/api/reports', report('shared-wait', { state: 'needs' }));
  const heard = await listen('bob', async () => {
    assert.equal((await call('alice', '/api/sessions/shared-wait/waiting', question)).status, 204);
  });
  assert.doesNotMatch(heard, /wait-alice-q1/);
  assert.equal((await sessionOf('alice', 'shared-wait'))?.waiting?.id, 'wait-alice-q1');
  assert.equal((await sessionOf('bob', 'shared-wait'))?.waiting, undefined);
  // A browser can't make a session wait, and a plugin can't report a wait on a session it hasn't.
  const waitFromBrowser = await fromBrowser('alice', '/api/sessions/shared-wait/waiting', question);
  assert.equal(waitFromBrowser.status, 403);
  assert.equal((await call('alice', '/api/sessions/nope/waiting', question)).status, 404);

  // Bob can't answer Alice's wait, a machine can't answer at all, and a wrong answer is refused.
  const to = '/api/sessions/shared-wait/answers';
  const body = { waitingId: 'wait-alice-q1', answer };
  assert.equal((await fromBrowser('bob', to, body)).status, 409);
  assert.equal((await call('alice', to, body)).status, 403);
  const wrong = { waitingId: 'wait-alice-q1', answer: { kind: 'permission', allow: true } };
  assert.equal((await fromBrowser('alice', to, wrong)).status, 400);

  // Alice's plugin holds its poll open; her answer from the browser lands in it at once.
  const polling = claim('alice', 'shared-wait', 'wait-alice-q1', 5000);
  const started = Date.now();
  assert.equal((await fromBrowser('alice', to, body)).status, 202);
  assert.deepEqual((await polling).answer, answer);
  assert.ok(Date.now() - started < 2000, 'the held poll hears the answer at once');
  // Taken once; a second answer is refused; Bob's plugin never sees it.
  assert.equal((await claim('alice', 'shared-wait', 'wait-alice-q1')).answer, null);
  assert.equal((await fromBrowser('alice', to, body)).status, 409);
  assert.equal((await claim('bob', 'shared-wait', 'wait-alice-q1')).answer, null);
  // A browser can't take answers or end a wait; Bob's plugin can't end Alice's.
  const claimed = await fromBrowser('alice', '/api/sessions/shared-wait/answers/claim', {
    waitingId: 'wait-alice-q1',
  });
  assert.equal(claimed.status, 403);
  const done = '/api/sessions/shared-wait/waiting/wait-alice-q1/done';
  assert.equal((await fromBrowser('alice', done, { by: 'joc' })).status, 403);
  assert.equal((await call('bob', done, { by: 'joc' })).status, 404);
  assert.equal((await call('alice', done, { by: 'joc' })).status, 204);
  const answered = await sessionOf('alice', 'shared-wait');
  assert.equal(answered?.waiting, undefined);
  assert.deepEqual(answered?.answered, { id: 'wait-alice-q1', by: 'joc' });
});

test('a JOC answer that comes after Claude Code was answered is dropped, and says so', async () => {
  const permission = {
    kind: 'permission',
    id: 'wait-alice-p1',
    tool: 'Bash',
    summary: 'pnpm prisma migrate reset',
  };
  const to = '/api/sessions/alice-race/answers';
  const body = { waitingId: 'wait-alice-p1', answer: { kind: 'permission', allow: true } };
  await call('alice', '/api/reports', report('alice-race', { state: 'needs' }));
  await call('alice', '/api/sessions/alice-race/waiting', permission);

  // Alice answers in the browser, but the terminal won before the plugin took it.
  assert.equal((await fromBrowser('alice', to, body)).status, 202);
  const done = '/api/sessions/alice-race/waiting/wait-alice-p1/done';
  assert.equal((await call('alice', done, { by: 'claude-code' })).status, 204);
  const claimed = await call('alice', '/api/sessions/alice-race/answers/claim', {
    waitingId: 'wait-alice-p1',
  });
  assert.equal((await read(claimed, ClaimedAnswer)).answer, null);

  // Answering again now says Claude Code answered it.
  const late = await fromBrowser('alice', to, body);
  assert.equal(late.status, 409);
  assert.equal((await read(late, AnswerRefused)).answeredBy, 'claude-code');

  // A session that ends waits on nothing.
  await call('alice', '/api/sessions/alice-race/waiting', { ...permission, id: 'wait-alice-p2' });
  await call('alice', '/api/reports', report('alice-race', { state: 'offline' }));
  const sessions = await read(await call('alice', '/api/sessions'), Sessions);
  assert.equal(sessions.find((s) => s.id === 'alice-race')?.waiting, undefined);
});

// ── Deleting sessions ────────────────────────────────────────────────────────

const Deletions = z.array(Deletion);
const History = z.array(HistorySession);

/** As the person's signed-in browser: GET without a body, POST with one. */
const asPerson = (who: Who, path: string, body?: unknown) =>
  app.request(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      cookie: cookies.get(who) ?? '',
      host: 'joc.test',
      origin: 'http://joc.test',
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const deletesOf = async (who: Who) => read(await asPerson(who, '/api/deletes'), Deletions);
const deleteClaims = async (who: Who, machine: string) =>
  (await read(await call(who, '/api/deletes/claim', { machine }), ClaimedDeletes)).deletes;
const historyOf = async (who: Who) => read(await asPerson(who, '/api/history'), History);

const GONE = '7d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6';

test('a session is deleted only by its owner, from a browser, and only once it ended', async () => {
  const alice = { machine: 'alice-laptop', title: 'Alice to delete' };
  await call('alice', '/api/reports', report(GONE, alice));
  // Bob has a session with the same id, which must stay as it is.
  await call('bob', '/api/reports', report(GONE, { machine: 'bob-laptop', title: 'Bob keeps' }));
  const item = { id: 'u1', at: new Date().toISOString(), kind: 'user', text: 'Hello' };
  await call('bob', '/api/messages', { sessionId: GONE, items: [item] });

  // Still running: refused, and says why.
  const running = await asPerson('alice', '/api/deletes', { sessionIds: [GONE] });
  assert.equal(running.status, 400);
  assert.equal((await read(running, DeleteRefused)).error, 'Still running. Quit it first.');
  // A machine never asks for a delete.
  assert.equal((await call('alice', '/api/deletes', { sessionIds: [GONE] })).status, 403);

  // It ends, with a conversation, a pasted image, a diff and a pin.
  const image = await read(await upload('alice', png('only in the deleted one')), ImageRef);
  const shared = await read(await upload('alice', png('also elsewhere')), ImageRef);
  const withImages = { ...item, images: [image, shared] };
  await call('alice', '/api/messages', { sessionId: GONE, items: [withImages] });
  await call('alice', '/api/messages', {
    sessionId: 'alice-keeps',
    items: [{ ...item, id: 'k1', images: [shared] }],
  });
  const firstDiff = { sessionId: GONE, at: ++clock, base: 'main', diff: '', truncated: false };
  assert.equal((await call('alice', '/api/changes', firstDiff)).status, 200);
  const commands = { sessionId: GONE, at: ++clock, commands: [] };
  assert.equal((await call('alice', '/api/commands', commands)).status, 200);
  await call('alice', '/api/reports', report(GONE, { ...alice, state: 'offline' }));
  const pin = await app.request('/api/prefs', {
    method: 'PATCH',
    headers: {
      cookie: cookies.get('alice') ?? '',
      host: 'joc.test',
      origin: 'http://joc.test',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ pinned: [GONE] }),
  });
  assert.equal(pin.status, 200);

  // Bob can't delete Alice's: his own of that id is still running.
  assert.equal((await asPerson('bob', '/api/deletes', { sessionIds: [GONE] })).status, 400);

  const asked = await asPerson('alice', '/api/deletes', { sessionIds: [GONE] });
  assert.equal(asked.status, 202);
  const [deletion] = await read(asked, Deletions);
  assert.deepEqual(
    [deletion?.status, deletion?.machine, deletion?.title],
    ['waiting', 'alice-laptop', 'Alice to delete'],
  );
  assert.deepEqual(await deletesOf('bob'), []);

  // Only Alice's plugin on that machine takes it: not Bob's, not a browser, not another machine.
  assert.deepEqual(await deleteClaims('bob', 'alice-laptop'), []);
  const browserClaim = await asPerson('alice', '/api/deletes/claim', { machine: 'alice-laptop' });
  assert.equal(browserClaim.status, 403);
  assert.deepEqual(await deleteClaims('alice', 'alice-desktop'), []);
  assert.deepEqual(await deleteClaims('alice', 'alice-laptop'), [
    { id: deletion?.id, sessionId: GONE },
  ]);
  assert.deepEqual(await deleteClaims('alice', 'alice-laptop'), []);
  assert.equal((await deletesOf('alice'))[0]?.status, 'deleting');

  // Only Alice's plugin says how it went.
  const result = `/api/deletes/${deletion?.id}/result`;
  assert.equal((await call('bob', result, { ok: true })).status, 404);
  assert.equal((await asPerson('alice', result, { ok: true })).status, 403);
  const removed = [`/Users/alice/.claude/projects/-work/${GONE}.jsonl`];
  assert.equal((await call('alice', result, { ok: true, removed })).status, 204);
  assert.equal((await deletesOf('alice'))[0]?.status, 'deleted');

  // Gone from Alice's JOC: the session, its conversation, diff, the image only it showed, its pin.
  assert.equal(
    (await historyOf('alice')).some((s) => s.id === GONE),
    false,
  );
  assert.deepEqual(await read(await call('alice', `/api/sessions/${GONE}/messages`), Items), []);
  assert.equal((await call('alice', `/api/sessions/${GONE}/changes`)).status, 404);
  assert.equal((await call('alice', `/api/sessions/${GONE}/commands`)).status, 404);
  assert.equal((await call('alice', `/api/images/${image.id}`)).status, 404);
  assert.equal((await call('alice', `/api/images/${shared.id}`)).status, 200);
  const prefs = await read(await asPerson('alice', '/api/prefs'), PrefsSnapshot);
  assert.equal(prefs.prefs.pinned.includes(GONE), false);

  // Bob's session of the same id is untouched.
  assert.deepEqual(
    (await historyOf('bob')).filter((s) => s.id === GONE).map((s) => [s.title, s.messages]),
    [['Bob keeps', 1]],
  );

  // A late report from Alice's machine can't bring it back; it's taken and ignored.
  const late = await call('alice', '/api/reports', report(GONE, alice));
  assert.equal(late.status, 200);
  assert.equal(
    (await call('alice', '/api/messages', { sessionId: GONE, items: [item] })).status,
    200,
  );
  const diff = { sessionId: GONE, at: ++clock, base: 'main', diff: '', truncated: false };
  assert.equal((await call('alice', '/api/changes', diff)).status, 200);
  assert.equal(
    (await historyOf('alice')).some((s) => s.id === GONE),
    false,
  );
  assert.deepEqual(await read(await call('alice', `/api/sessions/${GONE}/messages`), Items), []);
  // Bob's reports still land.
  await call('bob', '/api/reports', report(GONE, { machine: 'bob-laptop', state: 'needs' }));
  assert.equal((await historyOf('bob')).find((s) => s.id === GONE)?.state, 'needs');
});

test('a delete the machine refused says why, and the session stays', async () => {
  const id = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
  await call('alice', '/api/reports', report(id, { machine: 'alice-laptop', state: 'offline' }));
  const [deletion] = await read(
    await asPerson('alice', '/api/deletes', { sessionIds: [id] }),
    Deletions,
  );
  await deleteClaims('alice', 'alice-laptop');
  const detail = 'It has 2 unpushed commits in its worktree. Push or discard them first.';
  await call('alice', `/api/deletes/${deletion?.id}/result`, { ok: false, detail });
  const listed = (await deletesOf('alice')).find((d) => d.id === deletion?.id);
  assert.deepEqual([listed?.status, listed?.detail], ['failed', detail]);
  assert.equal(
    (await historyOf('alice')).some((s) => s.id === id),
    true,
  );
  // Asked again, it waits for the machine again.
  const again = await read(
    await asPerson('alice', '/api/deletes', { sessionIds: [id] }),
    Deletions,
  );
  assert.equal(again[0]?.status, 'waiting');
});

test('only Claude Code sessions with a machine can be deleted', async () => {
  await call('alice', '/api/reports', report('not-a-uuid', { state: 'offline', machine: 'm' }));
  const res = await asPerson('alice', '/api/deletes', { sessionIds: ['not-a-uuid', 'nope'] });
  assert.equal(res.status, 400);
  const refused = await read(res, DeleteRefused);
  assert.deepEqual(
    refused.sessions?.map((s) => s.id),
    ['not-a-uuid', 'nope'],
  );
});

test('a delete no machine takes in time fails, and says so', async () => {
  const owner = owners.get('alice');
  assert.ok(owner);
  const id = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';
  await call('alice', '/api/reports', report(id, { machine: 'alice-mini', state: 'offline' }));
  const now = Date.now();
  const outcome = await requestDeletes(owner, [id], now);
  assert.ok(outcome.ok);
  const later = (await listDeletes(owner, now + DELETE_WAIT_MS + 1)).find(
    (d) => d.sessionId === id,
  );
  assert.equal(later?.status, 'failed');
  assert.match(later?.detail ?? '', /Start Claude Code on alice-mini/);
  // And no plugin takes it any more.
  assert.deepEqual(
    await claimDeletes(owner, 'alice-mini', undefined, now + DELETE_WAIT_MS + 1),
    [],
  );
});

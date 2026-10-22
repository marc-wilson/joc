// Sign-in and machine linking through the routes, against the run's MongoDB, with GitHub
// replaced by a stand-in that knows two codes.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { closeClient } from '@joc/db';
import { AuthStatus, Device, DeviceStart, DeviceToken, PendingDevice } from '@joc/protocol';
import { z } from 'zod';
import { createApp } from './app.ts';
import type { GitHubAuth } from './github.ts';
import { useTestDb } from './test-db.ts';

before(async () => {
  await useTestDb('joc_identity_test');
});

after(async () => {
  await closeClient();
});

const people = new Map([
  ['carol-code', { id: 3, login: 'carol' }],
  ['dave-code', { id: 4, login: 'dave' }],
]);
const github: GitHubAuth = {
  authorizeUrl: (state) => `https://github.example/authorize?state=${state}`,
  profileFor: async (code) => people.get(code),
};
const app = createApp({ github, publicUrl: 'http://joc.test', pluginVersion: '1.0.0' });
const ORIGIN = { host: 'joc.test', origin: 'http://joc.test' };

/** The value a response set for a cookie. */
function cookie(res: Response, name: string): string | undefined {
  const line = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  return line?.slice(name.length + 1).split(';')[0] || undefined;
}

/** Signs in through the OAuth routes and returns the session cookie header. */
async function signIn(code: string, returnTo = '/'): Promise<string> {
  const start = await app.request(
    `http://joc.test/auth/github?return=${encodeURIComponent(returnTo)}`,
  );
  assert.equal(start.status, 302);
  const state = cookie(start, 'joc_oauth_state');
  const back = cookie(start, 'joc_return');
  assert.ok(state);
  assert.match(
    start.headers.get('location') ?? '',
    /^https:\/\/github\.example\/authorize\?state=/,
  );
  const callback = await app.request(
    `http://joc.test/auth/github/callback?code=${code}&state=${state}`,
    {
      headers: { cookie: `joc_oauth_state=${state}; joc_return=${back}` },
    },
  );
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('location'), returnTo);
  const session = cookie(callback, 'joc_session');
  assert.ok(session);
  return `joc_session=${session}`;
}

async function json<T>(res: Response, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(await res.json());
}

test('sign-in rejects a callback this browser did not start', async () => {
  const start = await app.request('http://joc.test/auth/github');
  const state = cookie(start, 'joc_oauth_state');
  const forged = await app.request(
    `http://joc.test/auth/github/callback?code=carol-code&state=other`,
    {
      headers: { cookie: `joc_oauth_state=${state}` },
    },
  );
  // Back to the page, saying why, with no session.
  assert.equal(forged.status, 302);
  assert.equal(forged.headers.get('location'), '/?github=expired');
  assert.equal(cookie(forged, 'joc_session'), undefined);
  const noCookie = await app.request(
    `http://joc.test/auth/github/callback?code=carol-code&state=${state}`,
  );
  assert.equal(noCookie.headers.get('location'), '/?github=expired');
  assert.equal(cookie(noCookie, 'joc_session'), undefined);
});

test('sign-in rejects a code GitHub refuses', async () => {
  const start = await app.request('http://joc.test/auth/github');
  const state = cookie(start, 'joc_oauth_state');
  const res = await app.request(`http://joc.test/auth/github/callback?code=bad&state=${state}`, {
    headers: { cookie: `joc_oauth_state=${state}; joc_return=%2Flink%3Fcode%3DAB` },
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/link?code=AB&github=failed');
  assert.equal(cookie(res, 'joc_session'), undefined);
});

test('a failed sign-in keeps the session the browser had, and a new one replaces it', async () => {
  const session = await signIn('carol-code');
  const start = await app.request('http://joc.test/auth/github');
  const state = cookie(start, 'joc_oauth_state');
  const failed = await app.request(`http://joc.test/auth/github/callback?code=bad&state=${state}`, {
    headers: { cookie: `joc_oauth_state=${state}; ${session}` },
  });
  assert.equal(failed.headers.get('location'), '/?github=failed');
  const still = await json(
    await app.request('/api/auth', { headers: { cookie: session } }),
    AuthStatus,
  );
  assert.equal(still.signedIn, true);
  const denied = await app.request(
    `http://joc.test/auth/github/callback?error=access_denied&state=${state}`,
    { headers: { cookie: `joc_oauth_state=${state}; ${session}` } },
  );
  assert.equal(denied.headers.get('location'), '/?github=denied');

  const again = await app.request('http://joc.test/auth/github');
  const next = cookie(again, 'joc_oauth_state');
  const replaced = await app.request(
    `http://joc.test/auth/github/callback?code=carol-code&state=${next}`,
    { headers: { cookie: `joc_oauth_state=${next}; ${session}` } },
  );
  assert.ok(cookie(replaced, 'joc_session'));
  const old = await json(
    await app.request('/api/auth', { headers: { cookie: session } }),
    AuthStatus,
  );
  assert.equal(old.signedIn, false);
});

test('a signed-in browser knows who it is, and an unsafe return path goes home', async () => {
  const session = await signIn('carol-code', '/link');
  const status = await json(
    await app.request('/api/auth', { headers: { cookie: session } }),
    AuthStatus,
  );
  assert.deepEqual([status.required, status.signedIn, status.user?.login], [true, true, 'carol']);
  const anonymous = await json(await app.request('/api/auth'), AuthStatus);
  assert.deepEqual([anonymous.signedIn, anonymous.user], [false, undefined]);
  await signIn('carol-code', '/'); // a second sign-in is fine
  const start = await app.request(
    `http://joc.test/auth/github?return=${encodeURIComponent('//evil.example')}`,
  );
  assert.equal(cookie(start, 'joc_return'), '%2F');
});

test('cookie writes must come from our own pages', async () => {
  const session = await signIn('carol-code');
  const post = (headers: Record<string, string>) =>
    app.request('http://joc.test/api/sessions/s1/prompts', {
      method: 'POST',
      headers: { cookie: session, 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ text: 'hello' }),
    });
  assert.equal((await post({})).status, 403);
  assert.equal((await post({ host: 'joc.test', origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(ORIGIN)).status, 201);
});

test('a machine links with a code and gets its own token, once', async () => {
  const carol = await signIn('carol-code');
  const start = await json(
    await app.request('/api/devices/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'carol-laptop' }),
    }),
    DeviceStart,
  );
  assert.match(start.userCode, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(start.verificationUri, 'http://joc.test/link');
  // The ready-made link carries the user code, never the secret device code.
  assert.equal(start.verificationUriComplete, `http://joc.test/link?code=${start.userCode}`);
  assert.ok(!start.verificationUriComplete.includes(start.deviceCode));

  // Before linking, the page can show which machine is asking, to a signed-in person only.
  const pending = (headers: Record<string, string>, code: string) =>
    app.request(`/api/devices/pending?code=${encodeURIComponent(code)}`, { headers });
  assert.equal((await pending({}, start.userCode)).status, 401);
  const asking = await json(await pending({ cookie: carol }, start.userCode), PendingDevice);
  assert.equal(asking.name, 'carol-laptop');
  assert.equal((await pending({ cookie: carol }, 'ZZZZ-ZZZZ')).status, 404);

  const poll = async () =>
    json(
      await app.request('/api/devices/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceCode: start.deviceCode }),
      }),
      DeviceToken,
    );
  assert.deepEqual(await poll(), { status: 'pending' });

  const approve = (headers: Record<string, string>, userCode: string) =>
    app.request('http://joc.test/api/devices/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ userCode }),
    });
  assert.equal((await approve({}, start.userCode)).status, 401);
  assert.equal((await approve({ cookie: carol, ...ORIGIN }, 'ZZZZ-ZZZZ')).status, 404);
  // Typed loosely, the way people type it.
  const typed = start.userCode.toLowerCase().replace('-', ' ');
  assert.equal((await approve({ cookie: carol, ...ORIGIN }, typed)).status, 204);

  const linked = await poll();
  assert.equal(linked.status, 'linked');
  assert.ok(linked.status === 'linked' && linked.login === 'carol');
  // Handed over exactly once, and the code can't be approved again.
  assert.deepEqual(await poll(), { status: 'expired' });
  assert.equal((await approve({ cookie: carol, ...ORIGIN }, start.userCode)).status, 404);

  const token = linked.status === 'linked' ? linked.token : '';
  const bearer = { authorization: `Bearer ${token}` };
  assert.equal((await app.request('/api/sessions', { headers: bearer })).status, 200);
  // A machine's token can't approve other machines or manage them.
  const other = await json(
    await app.request('/api/devices/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'someone-else' }),
    }),
    DeviceStart,
  );
  assert.equal((await approve(bearer, other.userCode)).status, 403);
  assert.equal((await app.request('/api/devices', { headers: bearer })).status, 403);
});

test('people see and revoke only their own machines', async () => {
  const carol = await signIn('carol-code');
  const dave = await signIn('dave-code');
  const list = async (session: string) =>
    json(await app.request('/api/devices', { headers: { cookie: session } }), z.array(Device));
  const carols = await list(carol);
  assert.ok(carols.length >= 1);
  assert.deepEqual(await list(dave), []);

  const target = carols[0]?.id ?? '';
  const revoke = (session: string) =>
    app.request(`http://joc.test/api/devices/${target}`, {
      method: 'DELETE',
      headers: { cookie: session, ...ORIGIN },
    });
  assert.equal((await revoke(dave)).status, 404);
  assert.equal((await revoke(carol)).status, 204);
  assert.equal(
    (await list(carol)).some((d) => d.id === target),
    false,
  );
});

test('a revoked machine is signed out', async () => {
  const carol = await signIn('carol-code');
  const start = await json(
    await app.request('/api/devices/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'to-revoke' }),
    }),
    DeviceStart,
  );
  await app.request('http://joc.test/api/devices/approve', {
    method: 'POST',
    headers: { cookie: carol, 'content-type': 'application/json', ...ORIGIN },
    body: JSON.stringify({ userCode: start.userCode }),
  });
  const linked = await json(
    await app.request('/api/devices/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceCode: start.deviceCode }),
    }),
    DeviceToken,
  );
  const bearer = { authorization: `Bearer ${linked.status === 'linked' ? linked.token : ''}` };
  const devices = await json(
    await app.request('/api/devices', { headers: { cookie: carol } }),
    z.array(Device),
  );
  const id = devices.find((d) => d.name === 'to-revoke')?.id ?? '';
  await app.request(`http://joc.test/api/devices/${id}`, {
    method: 'DELETE',
    headers: { cookie: carol, ...ORIGIN },
  });
  assert.equal((await app.request('/api/sessions', { headers: bearer })).status, 401);
});

test('signing out ends the session', async () => {
  const carol = await signIn('carol-code');
  assert.equal((await app.request('/api/sessions', { headers: { cookie: carol } })).status, 200);
  const crossSite = await app.request('http://joc.test/auth/logout', {
    method: 'POST',
    headers: { cookie: carol },
  });
  assert.equal(crossSite.status, 403);
  const out = await app.request('http://joc.test/auth/logout', {
    method: 'POST',
    headers: { cookie: carol, ...ORIGIN },
  });
  assert.equal(out.status, 204);
  assert.equal((await app.request('/api/sessions', { headers: { cookie: carol } })).status, 401);
});

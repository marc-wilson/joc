import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { requireToken, setTokenCookie, tokenMatches } from './auth.ts';

const TOKEN = 'harbor-labs-test-token';

test('tokenMatches accepts only the exact token', () => {
  assert.equal(tokenMatches(TOKEN, TOKEN), true);
  assert.equal(tokenMatches(`${TOKEN}x`, TOKEN), false);
  assert.equal(tokenMatches(TOKEN.slice(0, -1), TOKEN), false);
  assert.equal(tokenMatches('', TOKEN), false);
  assert.equal(tokenMatches(undefined, TOKEN), false);
});

function appWith(token: string | undefined) {
  const app = new Hono();
  app.use('/api/*', requireToken(token, ['/api/auth', '/api/login']));
  app.get('/api/auth', (c) => c.text('open'));
  app.get('/api/sessions', (c) => c.text('ok'));
  app.post('/api/login', (c) => {
    setTokenCookie(c, TOKEN);
    return c.body(null, 204);
  });
  return app;
}

test('requireToken lets everything through when no token is set', async () => {
  const res = await appWith(undefined).request('/api/sessions');
  assert.equal(res.status, 200);
});

test('requireToken checks the bearer header and the cookie', async () => {
  const app = appWith(TOKEN);
  assert.equal((await app.request('/api/sessions')).status, 401);
  assert.equal((await app.request('/api/auth')).status, 200);
  const bearer = (value: string) => ({ headers: { authorization: `Bearer ${value}` } });
  assert.equal((await app.request('/api/sessions', bearer('wrong'))).status, 401);
  assert.equal((await app.request('/api/sessions', bearer(TOKEN))).status, 200);
  const cookie = { headers: { cookie: `joc_token=${TOKEN}` } };
  assert.equal((await app.request('/api/sessions', cookie)).status, 200);
});

test('the cookie is HttpOnly and SameSite=Strict, and Secure over https', async () => {
  const app = appWith(TOKEN);
  const plain = (await app.request('http://localhost/api/login', { method: 'POST' })).headers;
  const cookie = plain.get('set-cookie') ?? '';
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);
  assert.doesNotMatch(cookie, /Secure/);
  const proxied = await app.request('http://localhost/api/login', {
    method: 'POST',
    headers: { 'x-forwarded-proto': 'https' },
  });
  assert.match(proxied.headers.get('set-cookie') ?? '', /Secure/);
});

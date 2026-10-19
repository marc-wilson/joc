import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { setTokenCookie, tokenMatches } from './auth.ts';

const TOKEN = 'harbor-labs-test-token';

test('tokenMatches accepts only the exact token', () => {
  assert.equal(tokenMatches(TOKEN, TOKEN), true);
  assert.equal(tokenMatches(`${TOKEN}x`, TOKEN), false);
  assert.equal(tokenMatches(TOKEN.slice(0, -1), TOKEN), false);
  assert.equal(tokenMatches('', TOKEN), false);
  assert.equal(tokenMatches(undefined, TOKEN), false);
});

function appWith() {
  const app = new Hono();
  app.post('/api/login', (c) => {
    setTokenCookie(c, TOKEN);
    return c.body(null, 204);
  });
  return app;
}

test('the cookie is HttpOnly and SameSite=Strict, and Secure over https', async () => {
  const app = appWith();
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

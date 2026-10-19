import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { safeReturnPath, sameOrigin, setSessionCookie } from './auth.ts';

test('return paths stay on this site', () => {
  assert.equal(safeReturnPath('/link'), '/link');
  assert.equal(safeReturnPath('/link?x=1'), '/link?x=1');
  for (const unsafe of [
    '//evil.example',
    '/\\evil.example',
    'https://evil.example',
    'link',
    '',
    undefined,
  ]) {
    assert.equal(safeReturnPath(unsafe), '/', String(unsafe));
  }
});

test('same origin means the Origin header names this host', async () => {
  const app = new Hono();
  app.post('/x', (c) => c.text(String(sameOrigin(c))));
  const ask = async (headers: Record<string, string>) =>
    (await app.request('http://joc.example/x', { method: 'POST', headers })).text();
  assert.equal(await ask({ host: 'joc.example', origin: 'https://joc.example' }), 'true');
  assert.equal(await ask({ host: 'joc.example', origin: 'https://evil.example' }), 'false');
  assert.equal(await ask({ host: 'joc.example' }), 'false');
  assert.equal(await ask({ host: 'joc.example', origin: 'null' }), 'false');
});

test('the session cookie is HttpOnly and SameSite=Lax, and Secure over https', async () => {
  const app = new Hono();
  app.get('/in', (c) => {
    setSessionCookie(c, 'secret');
    return c.body(null, 204);
  });
  const plain = (await app.request('http://localhost/in')).headers.get('set-cookie') ?? '';
  assert.match(plain, /HttpOnly/);
  assert.match(plain, /SameSite=Lax/);
  assert.match(plain, /Path=\//);
  assert.doesNotMatch(plain, /Secure/);
  const proxied = await app.request('http://localhost/in', {
    headers: { 'x-forwarded-proto': 'https' },
  });
  assert.match(proxied.headers.get('set-cookie') ?? '', /Secure/);
});

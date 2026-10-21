import assert from 'node:assert/strict';
import { test } from 'node:test';
import { githubAuth } from './github.ts';

const config = {
  clientId: 'client',
  clientSecret: 'not-a-real-secret',
  redirectUri: 'http://joc.test/auth/github/callback',
};

/** GitHub as sign-in sees it, made up: a token, a profile, and the person's installations. */
const fakeGitHub = (installations: Response | undefined) =>
  (async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    if (path === '/login/oauth/access_token') return Response.json({ access_token: 'made-up' });
    if (path === '/user') return Response.json({ id: 11, login: 'erin', name: null });
    if (path === '/user/installations' && installations) return installations;
    return new Response(null, { status: 404 });
  }) as typeof fetch;

test("an App sign-in reads the person's installations as they see them", async () => {
  const auth = githubAuth({
    ...config,
    app: true,
    fetch: fakeGitHub(
      Response.json({
        installations: [
          {
            id: 88,
            account: { id: 9100, login: 'harbor-labs', type: 'Organization' },
            repository_selection: 'all',
            suspended_at: null,
          },
          { id: 89, account: null },
        ],
      }),
    ),
  });
  const profile = await auth.profileFor('code');
  assert.deepEqual(profile, {
    id: 11,
    login: 'erin',
    name: undefined,
    avatarUrl: undefined,
    viaApp: true,
    installations: [88, 89],
    seen: [
      {
        id: 88,
        account: { id: 9100, login: 'harbor-labs', type: 'Organization' },
        selection: 'all',
        suspended: false,
      },
    ],
  });
});

test("an App sign-in whose installations GitHub won't list still signs in, keeping what's known", async () => {
  const auth = githubAuth({ ...config, app: true, fetch: fakeGitHub(undefined) });
  const profile = await auth.profileFor('code');
  assert.equal(profile?.viaApp, true);
  assert.equal(profile?.installations, undefined);
});

test('GitHub unreachable is a failed sign-in, not a crash', async () => {
  const auth = githubAuth({
    ...config,
    fetch: (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch,
  });
  assert.equal(await auth.profileFor('code'), undefined);
});

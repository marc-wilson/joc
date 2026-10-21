// "Sign in with GitHub": the web flow, used only to learn who someone is. It's the same flow for
// an OAuth app and a GitHub App (whose client id and secret then go here). GitHub's token is used
// once to read the profile (and, for the App, which of its installations the person can reach)
// and then dropped; JOC never stores it.
import { z } from 'zod';
import type { GitHubProfile } from './identity.ts';

// Only the fields JOC reads; GitHub's responses are external input like any other.
const TokenResponse = z.object({ access_token: z.string() });
const UserResponse = z.object({
  id: z.number(),
  login: z.string(),
  name: z.string().nullish(),
  avatar_url: z.string().nullish(),
});
const InstallationsResponse = z.object({
  installations: z.array(
    z.object({
      id: z.number(),
      account: z.object({ id: z.number(), login: z.string(), type: z.string() }).nullish(),
      repository_selection: z.string().optional(),
      suspended_at: z.string().nullish(),
    }),
  ),
});

export interface GitHubAuth {
  authorizeUrl(state: string): string;
  /** The profile behind an authorization code, or undefined when GitHub refused it. */
  profileFor(code: string): Promise<GitHubProfile | undefined>;
}

export interface GitHubConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** The client id and secret are a GitHub App's: sign-in also reads the person's installations. */
  app?: boolean;
  /** Stands in for the network in tests. */
  fetch?: typeof fetch;
}

export function githubAuth({
  clientId,
  clientSecret,
  redirectUri,
  app,
  fetch: doFetch = fetch,
}: GitHubConfig): GitHubAuth {
  return {
    authorizeUrl(state) {
      // No scopes: the public profile is all JOC needs.
      const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, state });
      return `https://github.com/login/oauth/authorize?${params}`;
    },

    async profileFor(code) {
      // GitHub unreachable is a failed sign-in, never a crash: the person keeps their session.
      const tokenRes = await doFetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
        signal: AbortSignal.timeout(10_000),
        // Unreachable: no answer, handled below as a failed sign-in.
      }).catch(() => undefined);
      // GitHub answers a bad or reused code with 200 and an `error` field, which fails here.
      const token = TokenResponse.safeParse(await tokenRes?.json().catch(() => null));
      if (!token.success) return undefined;

      const headers = {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token.data.access_token}`,
        'user-agent': 'joc',
      };
      const userRes = await doFetch('https://api.github.com/user', {
        headers,
        signal: AbortSignal.timeout(10_000),
        // Unreachable: no answer, handled below as a failed sign-in.
      }).catch(() => undefined);
      if (!userRes?.ok) return undefined;
      const user = UserResponse.safeParse(await userRes.json().catch(() => null));
      if (!user.success) return undefined;
      return {
        id: user.data.id,
        login: user.data.login,
        name: user.data.name ?? undefined,
        avatarUrl: user.data.avatar_url ?? undefined,
        ...(app ? { viaApp: true, ...(await installationsOf(doFetch, headers)) } : {}),
      };
    },
  };
}

/**
 * The App's installations the person can reach: on their own account, or an org they're in.
 * Nothing when GitHub didn't say, so what's known stays. `seen` is each one as the person sees
 * it, so JOC knows it before (or without) its installation webhook.
 */
async function installationsOf(
  doFetch: typeof fetch,
  headers: NonNullable<RequestInit['headers']>,
): Promise<Pick<GitHubProfile, 'installations' | 'seen'>> {
  const res = await doFetch('https://api.github.com/user/installations?per_page=100', {
    headers,
    signal: AbortSignal.timeout(10_000),
    // Unreachable: installations unknown, so coverage is left as it was.
  }).catch(() => undefined);
  if (!res?.ok) return {};
  const body = InstallationsResponse.safeParse(await res.json().catch(() => null));
  if (!body.success) return {};
  const all = body.data.installations;
  return {
    installations: all.map((i) => i.id),
    seen: all.flatMap((i) =>
      i.account
        ? [
            {
              id: i.id,
              account: i.account,
              selection: i.repository_selection ?? 'selected',
              suspended: !!i.suspended_at,
            },
          ]
        : [],
    ),
  };
}

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
const InstallationsResponse = z.object({ installations: z.array(z.object({ id: z.number() })) });

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
}

export function githubAuth({ clientId, clientSecret, redirectUri, app }: GitHubConfig): GitHubAuth {
  return {
    authorizeUrl(state) {
      // No scopes: the public profile is all JOC needs.
      const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, state });
      return `https://github.com/login/oauth/authorize?${params}`;
    },

    async profileFor(code) {
      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      // GitHub answers a bad or reused code with 200 and an `error` field, which fails here.
      const token = TokenResponse.safeParse(await tokenRes.json().catch(() => null));
      if (!token.success) return undefined;

      const headers = {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token.data.access_token}`,
        'user-agent': 'joc',
      };
      const userRes = await fetch('https://api.github.com/user', {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (!userRes.ok) return undefined;
      const user = UserResponse.safeParse(await userRes.json().catch(() => null));
      if (!user.success) return undefined;
      return {
        id: user.data.id,
        login: user.data.login,
        name: user.data.name ?? undefined,
        avatarUrl: user.data.avatar_url ?? undefined,
        ...(app ? { installations: await installationsOf(headers) } : {}),
      };
    },
  };
}

/**
 * The App's installations the person can reach: on their own account, or an org they're in.
 * Undefined when GitHub didn't say, so what's known stays.
 */
async function installationsOf(
  headers: NonNullable<RequestInit['headers']>,
): Promise<number[] | undefined> {
  const res = await fetch('https://api.github.com/user/installations?per_page=100', {
    headers,
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
  if (!res?.ok) return undefined;
  const body = InstallationsResponse.safeParse(await res.json().catch(() => null));
  return body.success ? body.data.installations.map((i) => i.id) : undefined;
}

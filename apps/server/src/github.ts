// "Sign in with GitHub": the OAuth web flow, used only to learn who someone is. GitHub's access
// token is used once to read the profile and then dropped; JOC never stores it.
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

export interface GitHubAuth {
  authorizeUrl(state: string): string;
  /** The profile behind an authorization code, or undefined when GitHub refused it. */
  profileFor(code: string): Promise<GitHubProfile | undefined>;
}

export interface GitHubConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function githubAuth({ clientId, clientSecret, redirectUri }: GitHubConfig): GitHubAuth {
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

      const userRes = await fetch('https://api.github.com/user', {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token.data.access_token}`,
          'user-agent': 'joc',
        },
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
      };
    },
  };
}

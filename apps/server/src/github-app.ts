// The JOC GitHub App's own access to GitHub: a short-lived JWT signed with the App's private key,
// traded for an installation token per installation, used for the few reads webhooks can't carry
// (a pull request's files, a team's members, the one-time backfill). Tokens live in memory only and
// are never logged.
import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';

export interface GitHubAppConfig {
  appId: string;
  /** The App's private key: PEM, PEM with `\n` escapes, or base64 of the PEM. */
  privateKey: string;
  /** Stands in for the network in tests. */
  fetch?: typeof fetch;
  /** GitHub's API root; a test points it elsewhere. */
  apiUrl?: string;
}

export interface GitHubAppApi {
  /** A GET against the API as the installation; undefined when GitHub didn't answer with JSON. */
  get(installationId: number, path: string): Promise<unknown>;
}

/** Reads the private key however it was pasted into the environment. */
export function parsePrivateKey(raw: string): KeyObject {
  const text = raw.includes('-----BEGIN')
    ? raw.replace(/\\n/g, '\n')
    : Buffer.from(raw.trim(), 'base64').toString('utf8');
  return createPrivateKey(text);
}

const b64url = (data: string | Buffer) => Buffer.from(data).toString('base64url');

/** The App's JWT: valid for 9 minutes, backdated a minute against clock drift. */
export function appJwt(appId: string, key: KeyObject, now = Date.now()): string {
  const iat = Math.floor(now / 1000) - 60;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat, exp: iat + 600, iss: appId }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(key).toString('base64url')}`;
}

const HEADERS = { accept: 'application/vnd.github+json', 'user-agent': 'joc' } as const;

export function githubAppApi(config: GitHubAppConfig): GitHubAppApi {
  const key = parsePrivateKey(config.privateKey);
  const doFetch = config.fetch ?? fetch;
  const api = (config.apiUrl ?? 'https://api.github.com').replace(/\/$/, '');
  /** Installation tokens, until five minutes before they expire. */
  const tokens = new Map<number, { token: string; until: number }>();

  async function token(installationId: number): Promise<string | undefined> {
    const kept = tokens.get(installationId);
    if (kept && kept.until > Date.now()) return kept.token;
    const res = await doFetch(`${api}/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers: { ...HEADERS, authorization: `Bearer ${appJwt(config.appId, key)}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return undefined;
    const body: unknown = await res.json().catch(() => null);
    if (!body || typeof body !== 'object' || !('token' in body) || typeof body.token !== 'string') {
      return undefined;
    }
    const expires = 'expires_at' in body ? Date.parse(String(body.expires_at)) : Number.NaN;
    const until = (Number.isFinite(expires) ? expires : Date.now() + 60 * 60_000) - 5 * 60_000;
    tokens.set(installationId, { token: body.token, until });
    return body.token;
  }

  return {
    async get(installationId, path) {
      const auth = await token(installationId);
      if (!auth) return undefined;
      const res = await doFetch(`${api}${path}`, {
        headers: { ...HEADERS, authorization: `Bearer ${auth}` },
        signal: AbortSignal.timeout(15_000),
      });
      // A revoked token: the next call asks for a new one.
      if (res.status === 401) tokens.delete(installationId);
      if (!res.ok) return undefined;
      return res.json().catch(() => undefined);
    },
  };
}

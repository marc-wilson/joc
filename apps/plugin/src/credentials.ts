import { chmodSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where `/joc-login` keeps this machine's link; register.ts writes the same file. */
export const credentialsFile = () => join(homedir(), '.claude', 'joc', 'credentials.json');

export interface Credentials {
  url: string;
  token: string;
}

/** This machine's link, if `/joc-login` made one. Tightens the file to owner-only on the way. */
export function readCredentials(file = credentialsFile()): Credentials | undefined {
  try {
    // The hooks module can't set a file's mode, so the first Node read does.
    if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
    const parsed: { url?: unknown; token?: unknown } = JSON.parse(readFileSync(file, 'utf8'));
    return typeof parsed.url === 'string' && typeof parsed.token === 'string'
      ? { url: parsed.url, token: parsed.token }
      : undefined;
  } catch {
    // No link yet, or an unreadable file: report as an unlinked machine would.
    return undefined;
  }
}

/** Where to report and as whom: JOC_URL/JOC_TOKEN when set, else the link, else local dev. */
export function connection(env: NodeJS.ProcessEnv, credentials: Credentials | undefined) {
  const url = env.JOC_URL || credentials?.url || 'http://localhost:3000';
  return {
    url: url.replace(/\/$/, ''),
    token: env.JOC_TOKEN || credentials?.token,
  };
}

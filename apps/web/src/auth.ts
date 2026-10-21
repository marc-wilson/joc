import { AuthStatus, type GitHubConnectionState, GitHubSignInNote, type User } from '@joc/protocol';
import { useEffect, useState } from 'react';

// Whether the dashboard may load, and as whom. The browser's session lives in an HttpOnly cookie,
// so all this tracks is GET /api/auth's answer, and any 401 since.

export type AuthState =
  | { status: 'checking' }
  | { status: 'signedOut' }
  /**
   * `user` is absent in local dev, where everything is open; `github` is how their GitHub
   * reaches JOC, absent when the server couldn't be asked.
   */
  | { status: 'signedIn'; user?: User; github?: GitHubConnectionState };

let state: AuthState = { status: 'checking' };
const listeners = new Set<(state: AuthState) => void>();

function set(next: AuthState) {
  state = next;
  for (const listener of listeners) listener(state);
}

/** Asks the server whether this browser is signed in. */
export async function checkAuth(): Promise<AuthState> {
  try {
    const status = AuthStatus.parse(await (await fetch('/api/auth')).json());
    set(
      status.signedIn
        ? { status: 'signedIn', user: status.user, github: status.github }
        : { status: 'signedOut' },
    );
  } catch {
    // The server is unreachable: show the app, which says it's reconnecting.
    set({ status: 'signedIn' });
  }
  return state;
}

/** This page, to come back to from GitHub. */
const here = () => encodeURIComponent(`${location.pathname}${location.search}${location.hash}`);

/**
 * Off to GitHub, and back to this page once signed in. Also how a signed-in person reconnects
 * through the GitHub App: the new session replaces this one only once GitHub signed them in, so
 * a sign-in that fails leaves them signed in as they were.
 */
export function signIn() {
  location.assign(`/auth/github?return=${here()}`);
}

export const reconnect = signIn;

/** Off to GitHub to install the GitHub App, and back to this page once it's installed. */
export function installApp() {
  location.assign(`/auth/github/install?return=${here()}`);
}

/**
 * How the last GitHub sign-in came back, if it didn't sign anyone in: read once from the page's
 * `github` parameter, which is then taken off the address.
 */
export const signInNote: GitHubSignInNote | undefined = (() => {
  if (typeof location === 'undefined') return undefined;
  const url = new URL(location.href);
  const note = GitHubSignInNote.safeParse(url.searchParams.get('github'));
  if (!note.success) return undefined;
  url.searchParams.delete('github');
  history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
  return note.data;
})();

export async function signOut(): Promise<void> {
  await fetch('/auth/logout', { method: 'POST' }).catch(() => undefined);
  set({ status: 'signedOut' });
}

/** `fetch` for the API: a 401 sends the app back to the sign-in screen. */
export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init);
  if (res.status === 401) set({ status: 'signedOut' });
  return res;
}

export function useAuth(): AuthState {
  const [current, setCurrent] = useState(state);
  useEffect(() => {
    listeners.add(setCurrent);
    setCurrent(state);
    if (state.status === 'checking') void checkAuth();
    return () => {
      listeners.delete(setCurrent);
    };
  }, []);
  return current;
}

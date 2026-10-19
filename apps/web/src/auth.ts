import { AuthStatus, type User } from '@joc/protocol';
import { useEffect, useState } from 'react';

// Whether the dashboard may load, and as whom. The browser's session lives in an HttpOnly cookie,
// so all this tracks is GET /api/auth's answer, and any 401 since.

export type AuthState =
  | { status: 'checking' }
  | { status: 'signedOut' }
  /** `user` is absent in local dev, where everything is open. */
  | { status: 'signedIn'; user?: User };

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
    set(status.signedIn ? { status: 'signedIn', user: status.user } : { status: 'signedOut' });
  } catch {
    // The server is unreachable: show the app, which says it's reconnecting.
    set({ status: 'signedIn' });
  }
  return state;
}

/** Off to GitHub, and back to this page once signed in. */
export function signIn() {
  const back = `${location.pathname}${location.search}`;
  location.assign(`/auth/github?return=${encodeURIComponent(back)}`);
}

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

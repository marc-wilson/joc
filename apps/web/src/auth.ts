import { AuthStatus } from '@joc/protocol';
import { useEffect, useState } from 'react';

// Whether the dashboard may load. The server holds the shared token in an HttpOnly cookie, so
// all this tracks is the answer to GET /api/auth, and any 401 since.

export type AuthState = 'checking' | 'signedOut' | 'signedIn';

let state: AuthState = 'checking';
const listeners = new Set<(state: AuthState) => void>();

function set(next: AuthState) {
  if (next === state) return;
  state = next;
  for (const listener of listeners) listener(state);
}

/** Asks the server whether this browser is signed in. */
export async function checkAuth(): Promise<AuthState> {
  try {
    const res = await fetch('/api/auth');
    const status = AuthStatus.parse(await res.json());
    set(status.required && !status.signedIn ? 'signedOut' : 'signedIn');
  } catch {
    // The server is unreachable: show the app, which says it's reconnecting.
    set('signedIn');
  }
  return state;
}

/** Sends the token; on success the server sets the cookie and the app loads. */
export async function signIn(token: string): Promise<boolean> {
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  }).catch(() => undefined);
  if (res?.ok) set('signedIn');
  return !!res?.ok;
}

/** `fetch` for the API: a 401 sends the app back to the sign-in screen. */
export async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init);
  if (res.status === 401) set('signedOut');
  return res;
}

export function useAuth(): AuthState {
  const [current, setCurrent] = useState(state);
  useEffect(() => {
    listeners.add(setCurrent);
    setCurrent(state);
    if (state === 'checking') void checkAuth();
    return () => {
      listeners.delete(setCurrent);
    };
  }, []);
  return current;
}

// Cookies and request credentials. A browser holds a session secret in an HttpOnly cookie
// (EventSource can't send headers); a machine sends its own token as a bearer header.
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

const SESSION_COOKIE = 'joc_session';
const STATE_COOKIE = 'joc_oauth_state';
const RETURN_COOKIE = 'joc_return';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
const STATE_MAX_AGE = 10 * 60;

function isHttps(c: Context): boolean {
  return (
    process.env.NODE_ENV === 'production' ||
    new URL(c.req.url).protocol === 'https:' ||
    c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() === 'https'
  );
}

/** The bearer token a request carries, if any. */
export function bearerToken(c: Context): string | undefined {
  return (
    c.req
      .header('authorization')
      ?.match(/^Bearer\s+(.+)$/i)?.[1]
      ?.trim() || undefined
  );
}

export const sessionSecret = (c: Context) => getCookie(c, SESSION_COOKIE) || undefined;

// Lax, not Strict: a link into JOC from elsewhere should arrive signed in. Cross-site writes are
// refused by `sameOrigin` instead, and Lax cookies aren't sent on cross-site POSTs anyway.
export function setSessionCookie(c: Context, secret: string) {
  setCookie(c, SESSION_COOKIE, secret, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    secure: isHttps(c),
    maxAge: SESSION_MAX_AGE,
  });
}

export const clearSessionCookie = (c: Context) => deleteCookie(c, SESSION_COOKIE, { path: '/' });

/** Remembers the OAuth state (against forged callbacks) and where to go after sign-in. */
export function setOAuthCookies(c: Context, state: string, returnTo: string) {
  const options = {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/auth',
    secure: isHttps(c),
    maxAge: STATE_MAX_AGE,
  } as const;
  setCookie(c, STATE_COOKIE, state, options);
  setCookie(c, RETURN_COOKIE, returnTo, options);
}

export function takeOAuthCookies(c: Context): { state?: string; returnTo: string } {
  const state = getCookie(c, STATE_COOKIE);
  const returnTo = safeReturnPath(getCookie(c, RETURN_COOKIE));
  deleteCookie(c, STATE_COOKIE, { path: '/auth' });
  deleteCookie(c, RETURN_COOKIE, { path: '/auth' });
  return { state, returnTo };
}

/** Only paths on this site: `//evil.example` and `/\evil.example` would leave it. */
export function safeReturnPath(path: string | undefined): string {
  return path && /^\/(?![/\\])/.test(path) ? path : '/';
}

/** True when a browser request comes from this site's own pages. */
export function sameOrigin(c: Context): boolean {
  const origin = c.req.header('origin');
  const host = c.req.header('host');
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    // Not a URL: a forged or broken header, so not this site.
    return false;
  }
}

/** The client's address for rate limits: the first hop the ingress saw. */
export const clientAddress = (c: Context) =>
  c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';

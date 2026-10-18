// One shared token guards the API. The plugin sends it as a bearer header; the browser holds it
// in an HttpOnly cookie, because EventSource can't send headers. With no token set (local dev),
// everything stays open.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';

export const COOKIE = 'joc_token';
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

/** Compares in constant time. Hashing first makes both sides the same length, so a length
 * mismatch takes the same path and leaks nothing about the token's length. */
export function tokenMatches(given: string | undefined, expected: string): boolean {
  if (given === undefined) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** The token a request carries: the bearer header first, then the cookie. */
export function requestToken(c: Context): string | undefined {
  const header = c.req.header('authorization');
  const bearer = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return bearer || getCookie(c, COOKIE) || undefined;
}

export function isSignedIn(c: Context, token: string | undefined): boolean {
  return token === undefined || tokenMatches(requestToken(c), token);
}

/** Rejects requests without the token. Pass the routes that stay reachable signed out. */
export function requireToken(token: string | undefined, open: string[]): MiddlewareHandler {
  return async (c, next) => {
    if (open.includes(c.req.path) || isSignedIn(c, token)) return next();
    return c.json({ error: 'Unauthorized' }, 401);
  };
}

function isHttps(c: Context): boolean {
  return (
    process.env.NODE_ENV === 'production' ||
    new URL(c.req.url).protocol === 'https:' ||
    c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() === 'https'
  );
}

export function setTokenCookie(c: Context, value: string) {
  setCookie(c, COOKIE, value, {
    httpOnly: true,
    sameSite: 'Strict',
    path: '/',
    secure: isHttps(c),
    maxAge: COOKIE_MAX_AGE,
  });
}

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** A random secret, URL-safe. 32 bytes by default: far beyond guessing. */
export const newSecret = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** What's stored for a secret: never the secret itself. */
export const hashSecret = (secret: string) => createHash('sha256').update(secret).digest('hex');

/** Compares in constant time; hashing first makes a length mismatch take the same path. */
export function secretsEqual(given: string | undefined, expected: string): boolean {
  if (given === undefined) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

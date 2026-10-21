// The GitHub App's webhook: GitHub signs every delivery with the webhook secret, and only a
// delivery whose signature checks out is taken. Each is taken once (GitHub redelivers on a
// timeout, and a person can redeliver by hand), answered at once, and handled after, one at a
// time in arrival order. Payloads are never logged: they can carry private code and comments.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getDb } from '@joc/db';
import { type Context as EventContext, handleEvent } from './github-events.ts';

/** Whether `signature` (the `X-Hub-Signature-256` header) signs `body` with `secret`. */
export function verifySignature(secret: string, body: string, signature: string | undefined) {
  if (!signature?.startsWith('sha256=')) return false;
  const given = Buffer.from(signature.slice('sha256='.length), 'hex');
  const expected = createHmac('sha256', secret).update(body, 'utf8').digest();
  // Constant time; a length mismatch (bad hex) can't be equal anyway.
  return given.length === expected.length && timingSafeEqual(given, expected);
}

interface DeliveryDoc {
  /** GitHub's `X-GitHub-Delivery`. */
  _id: string;
  event: string;
  at: Date;
}

/** Long past GitHub's redelivery window, then Mongo drops it (TTL). */
const KEPT_SECONDS = 3 * 24 * 60 * 60;

const deliveries = () => getDb().collection<DeliveryDoc>('github_deliveries');

let indexed: Promise<unknown> | undefined;
const ensureIndexes = () => {
  indexed ??= deliveries().createIndex({ at: 1 }, { expireAfterSeconds: KEPT_SECONDS });
  return indexed;
};

/** True the first time a delivery is seen; false for a redelivery. */
export async function firstDelivery(id: string, event: string): Promise<boolean> {
  await ensureIndexes();
  try {
    await deliveries().insertOne({ _id: id, event, at: new Date() });
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
      return false;
    }
    throw error;
  }
}

export interface Webhooks {
  secret: string;
  context: EventContext;
  /** Handles a verified delivery after the answer has gone. */
  enqueue(event: string, payload: unknown): void;
  /** Runs other work on the same queue (a sign-in's backfill), so it never races an event. */
  run(what: string, task: () => Promise<void>): void;
  /** Resolves once every delivery taken so far is handled: for tests and shutdown. */
  idle(): Promise<void>;
}

export function createWebhooks(secret: string, context: EventContext): Webhooks {
  let queue: Promise<void> = Promise.resolve();
  const run = (what: string, task: () => Promise<void>) => {
    queue = queue.then(() =>
      task().catch((error: unknown) => {
        // What it was only: never the payload.
        console.error(`${what} failed:`, String(error));
      }),
    );
  };
  return {
    secret,
    context,
    enqueue: (event, payload) =>
      run(`Handling a GitHub ${event} event`, () => handleEvent(context, event, payload)),
    run,
    idle: () => queue,
  };
}

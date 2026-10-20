import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { getDb } from '@joc/db';
import type { StreamEvent } from '@joc/protocol';
import type { Owner } from './owner.ts';

// Live updates, fanned out per owner to every server process (a pod; two run during every
// rolling deploy). A store publishes an event once; each process's browsers of that owner hear
// it once.
//
// - The publishing process hands it to its own listeners at once.
// - It also inserts it into the `events` collection. Every process tails that collection with
//   one change stream, filtered on the server to inserts from *other* processes, and hands what
//   arrives to its own listeners. So the writer never hears its own event twice.
// - A dropped stream resumes from its resume token. When it can't (the oplog moved on), the
//   process opens a fresh one and tells every listener it may have missed something, and the
//   live stream sends its browser a new snapshot to reload from.
//
// An events collection rather than change streams on each store's collection: the event a
// browser needs (a session as the dashboard shows it, only the fresh messages) is already made
// where it's published, and one stream covers every kind of update.

/** What a live stream sends besides its snapshot. */
export type LiveEvent = Exclude<StreamEvent, { type: 'snapshot' }>;

/** A live event, or word that some may have been lost: reload everything. */
export type BusMessage = LiveEvent | { type: 'missed' };

interface EventDoc {
  owner: string;
  /** The process that published it. */
  origin: string;
  /** The LiveEvent as JSON; absent when it was too big to pass on (`missed` for the owner). */
  event?: string;
  at: Date;
}

/** Events only matter live; the collection keeps them briefly, then MongoDB deletes them. */
const KEEP_SECONDS = 10 * 60;

/** An event this big goes to other processes as `missed`, so their browsers reload instead. */
const MAX_EVENT_CHARS = 4 * 1024 * 1024;

/** The longest pause between attempts to reopen a failed change stream. */
const MAX_RETRY_MS = 30_000;

export interface Bus {
  /** Hands the event to the owner's listeners in this process and every other. */
  publish(owner: Owner, event: LiveEvent): void;
  /** Listens for the owner's events, from any process. Returns the unsubscribe. */
  subscribe(owner: Owner, listener: (message: BusMessage) => void): () => void;
  /**
   * Starts hearing other processes, until `signal` aborts. Resolves once the change stream is
   * open, or once MongoDB says it has none (a standalone server in local development: this
   * process's own events still reach its listeners).
   */
  start(signal: AbortSignal): Promise<void>;
}

const events = () => getDb().collection<EventDoc>('events');

export function createBus(): Bus {
  const origin = randomUUID();
  const local = new EventEmitter().setMaxListeners(0);
  const channel = (owner: string) => `owner:${owner}`;
  /** Whether events go to other processes: from `start` on, while MongoDB streams changes. */
  let shared = false;
  let started: Promise<void> | undefined;

  // Inserted in publish order, one batch at a time, so another process hears a session's
  // updates in the order they happened.
  const queue: EventDoc[] = [];
  let flushing = false;
  const flush = () => {
    if (flushing || !queue.length || !shared) return;
    flushing = true;
    events()
      .insertMany(queue.splice(0), { ordered: true })
      .catch((error: unknown) => console.error('Sharing live updates failed:', error))
      .finally(() => {
        flushing = false;
        flush();
      });
  };

  function receive(doc: EventDoc) {
    let message: BusMessage = { type: 'missed' };
    if (doc.event !== undefined) {
      try {
        message = JSON.parse(doc.event) as LiveEvent;
      } catch {
        // Unreadable: the owner's browsers reload instead.
      }
    }
    local.emit(channel(doc.owner), message);
  }

  async function follow(signal: AbortSignal, opened: () => void) {
    let token: unknown;
    let openedOnce = false;
    let retryMs = 1000;
    while (!signal.aborted) {
      // Without a token, a stream that reopens starts from now: whatever came in between is lost.
      const missed = openedOnce && token === undefined;
      const stream = events().watch(
        [{ $match: { operationType: 'insert', 'fullDocument.origin': { $ne: origin } } }],
        token === undefined ? {} : { resumeAfter: token },
      );
      const close = () => void stream.close();
      signal.addEventListener('abort', close, { once: true });
      try {
        // The first read opens the stream; from then on nothing is missed.
        let change = await stream.tryNext();
        openedOnce = true;
        opened();
        retryMs = 1000;
        if (missed) local.emit('missed');
        for (;;) {
          if (change && change.operationType === 'insert') receive(change.fullDocument);
          token = stream.resumeToken ?? token;
          change = await stream.next();
        }
      } catch (error) {
        if (signal.aborted) return;
        if (unsupported(error)) {
          console.warn('MongoDB has no change streams: live updates stay within this process.');
          shared = false;
          queue.length = 0;
          opened();
          return;
        }
        token = stream.resumeToken ?? token;
        // The resume point is gone from the oplog: start over from now.
        if (historyLost(error)) token = undefined;
        console.error('The live update stream failed; reopening:', error);
        await sleep(retryMs, undefined, { signal }).catch(() => undefined);
        retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
      } finally {
        signal.removeEventListener('abort', close);
        await stream.close().catch(() => undefined);
      }
    }
  }

  return {
    publish(owner, event) {
      local.emit(channel(owner), event);
      if (!shared) return;
      const json = JSON.stringify(event);
      queue.push({
        owner,
        origin,
        event: json.length > MAX_EVENT_CHARS ? undefined : json,
        at: new Date(),
      });
      flush();
    },

    subscribe(owner, listener) {
      const missed = () => listener({ type: 'missed' });
      local.on(channel(owner), listener);
      local.on('missed', missed);
      return () => {
        local.off(channel(owner), listener);
        local.off('missed', missed);
      };
    },

    start(signal) {
      // One change stream per process, however often it's asked for.
      started ??= open(signal);
      return started;
    },
  };

  async function open(signal: AbortSignal) {
    if (signal.aborted) return;
    shared = true;
    signal.addEventListener('abort', () => {
      shared = false;
    });
    await events()
      .createIndex({ at: 1 }, { expireAfterSeconds: KEEP_SECONDS })
      .catch((error: unknown) => console.error('Indexing live updates failed:', error));
    await new Promise<void>((opened) => {
      signal.addEventListener('abort', () => opened(), { once: true });
      void follow(signal, opened);
    });
  }
}

const codeOf = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;

/** A standalone server: `$changeStream` needs a replica set. */
const unsupported = (error: unknown) => codeOf(error) === 40573;

/** ChangeStreamHistoryLost, or a resume token the server no longer accepts. */
const historyLost = (error: unknown) => codeOf(error) === 286 || codeOf(error) === 280;

/** This process's bus: every store publishes through it. */
export const bus = createBus();

/** Hands the event to the owner's listeners on every server process. */
export const publish = (owner: Owner, event: LiveEvent) => bus.publish(owner, event);

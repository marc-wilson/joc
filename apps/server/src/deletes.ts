// Deleting a session, for real: from the machine it ran on and from JOC. Nothing reaches into
// the machine: the server queues the delete for that machine, and a session running there takes
// it on its next poll, checks Claude Code no longer runs the session, deletes it (`claude rm`,
// or its transcript and the other files keyed by its id) and says how it went. Only then does
// the server drop JOC's copy, and keep a tombstone so a late report can't bring it back.
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { getDb } from '@joc/db';
import {
  type ClaimedDelete,
  ClaudeSessionId,
  type DeleteResult,
  type Deletion,
} from '@joc/protocol';
import { forgetAlerts } from './alerts.ts';
import { forgetAnswers } from './answers.ts';
import { forgetChanges } from './changes.ts';
import { forgetCommands } from './commands.ts';
import { deleteImages } from './images.ts';
import { forgetLaunches } from './launches.ts';
import { forgetMessages, imagesShown } from './messages.ts';
import { type Owner, sessionKey } from './owner.ts';
import { getPrefs, patchPrefs } from './prefs.ts';
import { forgetPrompts, imagesSent } from './prompts.ts';
import { deletableSessions, forgetSession } from './sessions.ts';

interface DeletionDoc {
  _id: string;
  owner: string;
  sessionId: string;
  title?: string;
  machine: string;
  /** The machine whose token last reported the session: only its plugin may take the delete. */
  device?: string;
  status: Deletion['status'];
  detail?: string;
  /** What the plugin removed, for the record. */
  removed?: string[];
  createdAt: Date;
  claimedAt?: Date;
}

/** A deleted session's id, kept a while so its late reports are ignored. */
interface TombstoneDoc {
  /** `owner/sessionId`. */
  _id: string;
  owner: string;
  sessionId: string;
  expiresAt: Date;
}

/** A delete no session on the machine took by then fails: it shouldn't happen long after. */
export const DELETE_WAIT_MS = 10 * 60_000;
/** A delete a plugin took but never reported on by then has failed. */
export const DELETE_REPORT_MS = 5 * 60_000;
/** How long a deleted session's reports are ignored. */
export const TOMBSTONE_MS = 30 * 24 * 60 * 60_000;
/** How far back the dashboard's list of deletes goes. */
const LISTED_FOR_MS = 24 * 60 * 60_000;

const deletions = () => getDb().collection<DeletionDoc>('deletions');
const tombstones = () => getDb().collection<TombstoneDoc>('tombstones');

let indexed: Promise<unknown> | undefined;
const ensureIndexes = () => {
  indexed ??= Promise.all([
    deletions().createIndex({ owner: 1, createdAt: 1 }),
    deletions().createIndex({ owner: 1, machine: 1, status: 1, createdAt: 1 }),
    // Mongo drops a tombstone once it expires; reads check `expiresAt` too, as that's lazy.
    tombstones().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]);
  return indexed;
};

// Same per-owner, in-process fan-out as session updates (see sessions.ts).
const updates = new EventEmitter().setMaxListeners(0);
const changed = (owner: Owner) => updates.emit(`deletes:${owner}`);

/** A nudge whenever one of the owner's deletes is asked for or changes. */
export function onDeletes(owner: Owner, listener: () => void): () => void {
  updates.on(`deletes:${owner}`, listener);
  return () => updates.off(`deletes:${owner}`, listener);
}

/** One of the owner's sessions was deleted. */
export function onDeleted(owner: Owner, listener: (sessionId: string) => void): () => void {
  updates.on(`deleted:${owner}`, listener);
  return () => updates.off(`deleted:${owner}`, listener);
}

const unclaimed = (machine: string) =>
  `No Claude Code session on ${machine} took it within ${DELETE_WAIT_MS / 60_000} minutes, so nothing was deleted. Start Claude Code on ${machine} and try again.`;
const unreported = (machine: string) =>
  `${machine} didn't say how it went. Try again: what's already gone is skipped.`;

function toDeletion(doc: DeletionDoc, now: number): Deletion {
  const waitedOut =
    doc.status === 'waiting' && now - doc.createdAt.getTime() > DELETE_WAIT_MS
      ? unclaimed(doc.machine)
      : undefined;
  const silent =
    doc.status === 'deleting' && doc.claimedAt && now - doc.claimedAt.getTime() > DELETE_REPORT_MS
      ? unreported(doc.machine)
      : undefined;
  const detail = waitedOut ?? silent ?? doc.detail;
  return {
    id: doc._id,
    sessionId: doc.sessionId,
    ...(doc.title ? { title: doc.title } : {}),
    machine: doc.machine,
    status: waitedOut || silent ? 'failed' : doc.status,
    ...(detail ? { detail } : {}),
    createdAt: doc.createdAt.toISOString(),
  };
}

/** Whether the owner deleted this session lately: then whatever it still reports is ignored. */
export async function isDeleted(owner: Owner, sessionId: string, now = Date.now()) {
  const doc = await tombstones().findOne({
    _id: sessionKey(owner, sessionId),
    owner,
    expiresAt: { $gt: new Date(now) },
  });
  return doc !== null;
}

export const STILL_RUNNING = 'Still running. Quit it first.';

export type RequestOutcome =
  | { ok: true; deletions: Deletion[] }
  | { ok: false; refused: { id: string; reason: string }[] };

/**
 * Queues the owner's sessions for deleting on their machines. Only ended ones: a session still
 * reporting is refused, and so is the whole request if any is. A session already being deleted
 * keeps its delete.
 */
export async function requestDeletes(
  owner: Owner,
  sessionIds: string[],
  now = Date.now(),
): Promise<RequestOutcome> {
  await ensureIndexes();
  const ids = [...new Set(sessionIds)];
  const found = new Map((await deletableSessions(owner, ids, now)).map((s) => [s.sessionId, s]));
  const refused: { id: string; reason: string }[] = [];
  for (const id of ids) {
    const session = found.get(id);
    const reason = !session
      ? 'No such session'
      : !ClaudeSessionId.safeParse(id).success
        ? "That isn't a Claude Code session id, so there's nothing to delete on a machine."
        : !session.machine
          ? "JOC doesn't know which machine it ran on."
          : !session.ended
            ? STILL_RUNNING
            : undefined;
    if (reason) refused.push({ id, reason });
  }
  if (refused.length) return { ok: false, refused };

  const result: Deletion[] = [];
  for (const id of ids) {
    const session = found.get(id);
    if (!session?.machine) continue;
    const open = await deletions().findOne(
      { owner, sessionId: id, status: { $in: ['waiting', 'deleting'] } },
      { sort: { createdAt: -1 } },
    );
    if (open && toDeletion(open, now).status !== 'failed') {
      result.push(toDeletion(open, now));
      continue;
    }
    const doc: DeletionDoc = {
      _id: randomUUID(),
      owner,
      sessionId: id,
      ...(session.title ? { title: session.title } : {}),
      machine: session.machine,
      ...(session.device ? { device: session.device } : {}),
      status: 'waiting',
      createdAt: new Date(now),
    };
    await deletions().insertOne(doc);
    result.push(toDeletion(doc, now));
  }
  changed(owner);
  return { ok: true, deletions: result };
}

/** The owner's deletes of the last day, oldest first. */
export async function listDeletes(owner: Owner, now = Date.now()): Promise<Deletion[]> {
  const docs = await deletions()
    .find({ owner, createdAt: { $gt: new Date(now - LISTED_FOR_MS) } })
    .sort({ createdAt: 1 })
    .toArray();
  return docs.map((d) => toDeletion(d, now));
}

/**
 * Hands the deletes waiting for `machine` to a plugin there, each once, oldest first. With the
 * machine's token (`device`), only the deletes of sessions that machine reported.
 */
export async function claimDeletes(
  owner: Owner,
  machine: string,
  device: string | undefined,
  now = Date.now(),
  max = 10,
): Promise<ClaimedDelete[]> {
  const claimed: ClaimedDelete[] = [];
  let changes = false;
  while (claimed.length < max) {
    const doc = await deletions().findOneAndUpdate(
      {
        owner,
        machine,
        status: 'waiting',
        createdAt: { $gt: new Date(now - DELETE_WAIT_MS) },
        ...(device ? { $or: [{ device: { $exists: false } }, { device }] } : {}),
      },
      { $set: { status: 'deleting', claimedAt: new Date(now) } },
      { sort: { createdAt: 1 } },
    );
    if (!doc) break;
    changes = true;
    claimed.push({ id: doc._id, sessionId: doc.sessionId });
  }
  if (changes) changed(owner);
  return claimed;
}

/**
 * What the plugin said of a delete it took. Gone from the machine, JOC's copy goes too. False
 * when the owner has no such delete under way.
 */
export async function finishDelete(
  owner: Owner,
  id: string,
  { ok, removed, detail }: DeleteResult,
  now = Date.now(),
): Promise<boolean> {
  const doc = await deletions().findOneAndUpdate(
    { _id: id, owner, status: 'deleting' },
    {
      $set: ok
        ? { status: 'deleted', ...(removed ? { removed } : {}) }
        : {
            status: 'failed',
            detail: detail || "It wasn't deleted.",
            ...(removed ? { removed } : {}),
          },
    },
  );
  if (!doc) return false;
  if (ok) {
    await forget(owner, doc.sessionId, now);
    updates.emit(`deleted:${owner}`, doc.sessionId);
  }
  changed(owner);
  return true;
}

/**
 * Drops everything JOC keeps of one of the owner's sessions. The tombstone goes first, so a
 * report that comes in meanwhile is already ignored.
 */
async function forget(owner: Owner, sessionId: string, now: number): Promise<void> {
  await ensureIndexes();
  await tombstones().updateOne(
    { _id: sessionKey(owner, sessionId) },
    { $set: { owner, sessionId, expiresAt: new Date(now + TOMBSTONE_MS) } },
    { upsert: true },
  );
  const images = [
    ...new Set([
      ...(await forgetMessages(owner, sessionId)),
      ...(await forgetPrompts(owner, sessionId)),
    ]),
  ];
  // Only the images nothing else of the owner's still shows.
  const kept = new Set([
    ...(await imagesShown(owner, images)),
    ...(await imagesSent(owner, images)),
  ]);
  await deleteImages(
    owner,
    images.filter((i) => !kept.has(i)),
  );
  await forgetChanges(owner, sessionId);
  await forgetCommands(owner, sessionId);
  await forgetAnswers(owner, sessionId);
  await forgetAlerts(owner, sessionId);
  await forgetLaunches(owner, sessionId);
  await forgetSession(owner, sessionId);
  // With the session gone, its pin and folds are pruned on the next write: make it now.
  const { saved, prefs } = await getPrefs(owner);
  if (
    saved &&
    (prefs.pinned.includes(sessionId) || prefs.sessions.some((s) => s.id === sessionId))
  ) {
    await patchPrefs(owner, {});
  }
}

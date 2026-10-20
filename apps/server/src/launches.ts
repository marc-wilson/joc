// New sessions asked for from the dashboard, such as one that reviews a pull request. Nothing
// reaches into the machine: a session running on the repo takes the launch on its next poll and
// starts `claude --bg` in its folder, then says how it went and which session it started. The
// server only records what was asked; the new session reports itself like any other.
import { randomUUID } from 'node:crypto';
import { getDb } from '@joc/db';
import type { ClaimedLaunch, Launch, LaunchResult, LaunchReview } from '@joc/protocol';
import { publish } from './bus.ts';
import type { Owner } from './owner.ts';

interface LaunchDoc {
  _id: string;
  owner: string;
  /** The session whose plugin starts it. */
  from: string;
  repo?: string;
  review?: LaunchReview;
  prompt?: string;
  status: Launch['status'];
  sessionId?: string;
  detail?: string;
  createdAt: Date;
  claimedAt?: Date;
}

/** A launch nobody took by then never starts: a session shouldn't begin long after it was asked. */
export const LAUNCH_WAIT_MS = 10 * 60_000;

/** How far back the dashboard's list of launches goes. */
const LISTED_FOR_MS = 24 * 60 * 60_000;

const launches = () => getDb().collection<LaunchDoc>('launches');

let indexed: Promise<unknown> | undefined;
const ensureIndexes = () => {
  indexed ??= Promise.all([
    launches().createIndex({ owner: 1, createdAt: 1 }),
    launches().createIndex({ owner: 1, from: 1, claimedAt: 1, createdAt: 1 }),
  ]);
  return indexed;
};

// Only a nudge goes out to the owner's dashboards; each fetches the launches.
const changed = (owner: Owner) => publish(owner, { type: 'launches' });

const UNCLAIMED = "The session it starts from didn't pick it up. Is it still open?";

function toLaunch(doc: LaunchDoc, now: number): Launch {
  const expired =
    doc.status === 'starting' && !doc.claimedAt && now - doc.createdAt.getTime() > LAUNCH_WAIT_MS;
  return {
    id: doc._id,
    from: doc.from,
    ...(doc.repo ? { repo: doc.repo } : {}),
    ...(doc.review ? { review: doc.review } : {}),
    ...(doc.prompt ? { prompt: doc.prompt } : {}),
    status: expired ? 'failed' : doc.status,
    ...(doc.sessionId ? { sessionId: doc.sessionId } : {}),
    ...(expired ? { detail: UNCLAIMED } : doc.detail ? { detail: doc.detail } : {}),
    createdAt: doc.createdAt.toISOString(),
  };
}

/** Queues a new session for the plugin of the live session `from`, which starts it. */
export async function createLaunch(
  owner: Owner,
  launch: { from: string; repo?: string; prompt?: string; review?: LaunchReview },
): Promise<Launch> {
  await ensureIndexes();
  const doc: LaunchDoc = {
    _id: randomUUID(),
    owner,
    from: launch.from,
    ...(launch.repo ? { repo: launch.repo } : {}),
    ...(launch.review ? { review: launch.review } : {}),
    ...(launch.prompt ? { prompt: launch.prompt } : {}),
    status: 'starting',
    createdAt: new Date(),
  };
  await launches().insertOne(doc);
  changed(owner);
  return toLaunch(doc, Date.now());
}

/** The owner's launches of the last day, oldest first; with a PR, only the ones reviewing it. */
export async function listLaunches(
  owner: Owner,
  pr?: { repo: string; number: number },
  now = Date.now(),
): Promise<Launch[]> {
  const docs = await launches()
    .find({
      owner,
      createdAt: { $gt: new Date(now - LISTED_FOR_MS) },
      ...(pr ? { 'review.repo': pr.repo, 'review.number': pr.number } : {}),
    })
    .sort({ createdAt: 1 })
    .toArray();
  return docs.map((d) => toLaunch(d, now));
}

/** Hands the new sessions waiting on this one to its plugin, each once, oldest first. */
export async function claimLaunches(
  owner: Owner,
  from: string,
  now = Date.now(),
  max = 5,
): Promise<ClaimedLaunch[]> {
  const claimed: ClaimedLaunch[] = [];
  while (claimed.length < max) {
    const doc = await launches().findOneAndUpdate(
      {
        owner,
        from,
        status: 'starting',
        claimedAt: { $exists: false },
        createdAt: { $gt: new Date(now - LAUNCH_WAIT_MS) },
      },
      { $set: { claimedAt: new Date(now) } },
      { sort: { createdAt: 1 } },
    );
    if (!doc) break;
    claimed.push({
      id: doc._id,
      ...(doc.review ? { name: `Review ${doc.review.repo}#${doc.review.number}` } : {}),
      ...(doc.prompt ? { prompt: doc.prompt } : {}),
    });
  }
  return claimed;
}

/** What the plugin said of a launch it took. False when the owner has no such launch. */
export async function finishLaunch(
  owner: Owner,
  id: string,
  { ok, sessionId, detail }: LaunchResult,
): Promise<boolean> {
  const result = await launches().updateOne(
    { _id: id, owner, claimedAt: { $exists: true } },
    {
      $set: ok
        ? { status: 'started', ...(sessionId ? { sessionId } : {}) }
        : { status: 'failed', detail: detail || "Claude Code didn't start." },
    },
  );
  if (!result.matchedCount) return false;
  changed(owner);
  return true;
}

/** Deletes the launches a deleted session started, or that started it. */
export async function forgetLaunches(owner: Owner, sessionId: string): Promise<void> {
  const res = await launches().deleteMany({ owner, $or: [{ from: sessionId }, { sessionId }] });
  if (res.deletedCount) changed(owner);
}

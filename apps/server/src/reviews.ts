// Pull request reviews asked for from the dashboard, and the new sessions they start. A review
// always runs in a real Claude Code session: an open one gets it as a queued prompt; otherwise a
// session open on the repo takes a launch on its next poll and starts `claude --bg` beside
// itself. Either way the server only records what was asked and links the PR to that session.
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { getDb } from '@joc/db';
import type { ClaimedLaunch, LaunchResult, Review, ReviewTarget } from '@joc/protocol';
import type { Owner } from './owner.ts';
import { queuePrompt } from './prompts.ts';

interface ReviewDoc {
  _id: string;
  owner: string;
  repo: string;
  number: number;
  sessionId: string;
  kind: ReviewTarget['kind'];
  prompt: string;
  status: Review['status'];
  detail?: string;
  /** For a new session: the session whose plugin starts it. */
  from?: string;
  createdAt: Date;
  claimedAt?: Date;
}

/** A launch nobody took by then never starts: a review shouldn't begin long after it was asked. */
export const LAUNCH_WAIT_MS = 10 * 60_000;

const reviews = () => getDb().collection<ReviewDoc>('reviews');

let indexed: Promise<unknown> | undefined;
const ensureIndexes = () => {
  indexed ??= Promise.all([
    reviews().createIndex({ owner: 1, repo: 1, number: 1, createdAt: 1 }),
    reviews().createIndex({ owner: 1, from: 1, claimedAt: 1, createdAt: 1 }),
  ]);
  return indexed;
};

// Same per-owner, in-process fan-out as session updates (see sessions.ts). Only a nudge goes
// out; each dashboard fetches the PR's reviews.
const updates = new EventEmitter().setMaxListeners(0);
const changed = (owner: Owner) => updates.emit(`reviews:${owner}`);

export function onReviews(owner: Owner, listener: () => void): () => void {
  updates.on(`reviews:${owner}`, listener);
  return () => updates.off(`reviews:${owner}`, listener);
}

const UNCLAIMED = "The session on this repo didn't pick it up. Is it still open?";

function toReview(doc: ReviewDoc, now: number): Review {
  const expired =
    doc.status === 'starting' && !doc.claimedAt && now - doc.createdAt.getTime() > LAUNCH_WAIT_MS;
  return {
    id: doc._id,
    repo: doc.repo,
    number: doc.number,
    sessionId: doc.sessionId,
    kind: doc.kind,
    prompt: doc.prompt,
    status: expired ? 'failed' : doc.status,
    detail: expired ? UNCLAIMED : doc.detail,
    createdAt: doc.createdAt.toISOString(),
  };
}

/**
 * Records a review and sets it going: queued as a prompt for an open session, or as a launch
 * for the session the new one starts from. The new session's id is chosen here, so the PR
 * links to it before it starts.
 */
export async function createReview(
  owner: Owner,
  pr: { repo: string; number: number },
  prompt: string,
  target: ReviewTarget,
): Promise<Review> {
  await ensureIndexes();
  const doc: ReviewDoc = {
    _id: randomUUID(),
    owner,
    repo: pr.repo,
    number: pr.number,
    prompt,
    createdAt: new Date(),
    ...(target.kind === 'session'
      ? { kind: 'session', sessionId: target.sessionId, status: 'sent' }
      : { kind: 'new', sessionId: randomUUID(), status: 'starting', from: target.from }),
  };
  if (target.kind === 'session') await queuePrompt(owner, target.sessionId, prompt);
  await reviews().insertOne(doc);
  changed(owner);
  return toReview(doc, Date.now());
}

/** The owner's reviews of one PR, oldest first. */
export async function listReviews(
  owner: Owner,
  repo: string,
  number: number,
  now = Date.now(),
): Promise<Review[]> {
  const docs = await reviews().find({ owner, repo, number }).sort({ createdAt: 1 }).toArray();
  return docs.map((d) => toReview(d, now));
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
    const doc = await reviews().findOneAndUpdate(
      {
        owner,
        from,
        kind: 'new',
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
      sessionId: doc.sessionId,
      name: `Review ${doc.repo}#${doc.number}`,
      prompt: doc.prompt,
    });
  }
  return claimed;
}

/** What the plugin said of a launch it took. False when the owner has no such launch. */
export async function finishLaunch(
  owner: Owner,
  id: string,
  { ok, detail }: LaunchResult,
): Promise<boolean> {
  const result = await reviews().updateOne(
    { _id: id, owner, kind: 'new', claimedAt: { $exists: true } },
    {
      $set: ok
        ? { status: 'started' }
        : { status: 'failed', detail: detail || "Claude Code didn't start." },
    },
  );
  if (!result.matchedCount) return false;
  changed(owner);
  return true;
}

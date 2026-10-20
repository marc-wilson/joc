// Resuming an ended session from the dashboard. Nothing reaches into the machine: the server
// queues the resume for a machine, and a session running there takes it on its next poll, checks
// Claude Code no longer runs the session, and runs `claude --bg --resume <id>` in the session's
// folder. The session keeps its id, so its plugin's next report brings JOC's row back to life.
// A deleted session can't be resumed: JOC no longer has it.
import { randomUUID } from 'node:crypto';
import { getDb } from '@joc/db';
import type { ClaimedResume, Resume, ResumeResult } from '@joc/protocol';
import { publish } from './bus.ts';
import { openDeletion } from './deletes.ts';
import type { Owner } from './owner.ts';
import { deletableSessions } from './sessions.ts';

interface ResumeDoc {
  _id: string;
  owner: string;
  sessionId: string;
  machine: string;
  /** The machine whose token last reported the session, when it resumes there: only its plugin may take it. */
  device?: string;
  /** The session's folder, where `claude --resume` runs. */
  cwd?: string;
  status: Resume['status'];
  reason?: string;
  detail?: string;
  createdAt: Date;
  claimedAt?: Date;
  startedAt?: Date;
}

/** A resume no session on the machine took by then fails: it shouldn't start long after. */
export const RESUME_WAIT_MS = 10 * 60_000;
/** A resume a plugin took but never reported on by then has failed (`claude --bg` takes ~1m at most). */
export const RESUME_REPORT_MS = 2 * 60_000;
/** How far back the dashboard's list of resumes goes. */
const LISTED_FOR_MS = 24 * 60 * 60_000;

const resumes = () => getDb().collection<ResumeDoc>('resumes');

let indexed: Promise<unknown> | undefined;
const ensureIndexes = () => {
  indexed ??= Promise.all([
    resumes().createIndex({ owner: 1, createdAt: 1 }),
    resumes().createIndex({ owner: 1, machine: 1, status: 1, createdAt: 1 }),
  ]);
  return indexed;
};

/** A nudge to every dashboard of the owner whenever one of their resumes is asked for or changes. */
const changed = (owner: Owner) => publish(owner, { type: 'resumes' });

function toResume(doc: ResumeDoc, now: number): Resume {
  const waitedOut =
    doc.status === 'waiting' && now - doc.createdAt.getTime() > RESUME_WAIT_MS
      ? {
          reason: `no Claude Code session took it within ${RESUME_WAIT_MS / 60_000} minutes`,
          detail: `Start Claude Code on ${doc.machine} and try again.`,
        }
      : undefined;
  const silent =
    doc.status === 'starting' && doc.claimedAt && now - doc.claimedAt.getTime() > RESUME_REPORT_MS
      ? {
          reason: `no response after ${RESUME_REPORT_MS / 60_000}m`,
          detail: `${doc.machine} took it but didn't say how it went.`,
        }
      : undefined;
  const failure = waitedOut ?? silent;
  const reason = failure?.reason ?? doc.reason;
  const detail = failure?.detail ?? doc.detail;
  return {
    id: doc._id,
    sessionId: doc.sessionId,
    machine: doc.machine,
    status: failure ? 'failed' : doc.status,
    ...(reason ? { reason } : {}),
    ...(detail ? { detail } : {}),
    createdAt: doc.createdAt.toISOString(),
    ...(doc.startedAt ? { startedAt: doc.startedAt.toISOString() } : {}),
  };
}

/** Whether a resume is still under way: asked for, or taken and not yet reported on. */
const underWay = (r: Resume) => r.status === 'waiting' || r.status === 'starting';

export type ResumeOutcome = { ok: true; resume: Resume } | { ok: false; reason: string };

/**
 * Queues one of the owner's ended sessions to resume, on the machine it ran on or `machine`.
 * A session still running is refused, and so is one being deleted. A resume already under way
 * for it is returned rather than queued twice.
 */
export async function requestResume(
  owner: Owner,
  sessionId: string,
  machine?: string,
  now = Date.now(),
): Promise<ResumeOutcome> {
  await ensureIndexes();
  const [session] = await deletableSessions(owner, [sessionId], now);
  if (!session) return { ok: false, reason: 'No such session' };
  if (!session.ended) return { ok: false, reason: "It's still running." };
  const on = machine ?? session.machine;
  if (!on) return { ok: false, reason: "JOC doesn't know which machine it ran on." };
  if (await openDeletion(owner, sessionId, now)) {
    return { ok: false, reason: "It's being deleted." };
  }
  const open = await resumes().findOne(
    { owner, sessionId, status: { $in: ['waiting', 'starting'] } },
    { sort: { createdAt: -1 } },
  );
  if (open && underWay(toResume(open, now))) return { ok: true, resume: toResume(open, now) };

  const doc: ResumeDoc = {
    _id: randomUUID(),
    owner,
    sessionId,
    machine: on,
    // Another machine has no token of this session's: any of the owner's machines by that name.
    ...(on === session.machine && session.device ? { device: session.device } : {}),
    ...(session.cwd ? { cwd: session.cwd } : {}),
    status: 'waiting',
    createdAt: new Date(now),
  };
  await resumes().insertOne(doc);
  changed(owner);
  return { ok: true, resume: toResume(doc, now) };
}

/** The owner's resumes of the last day, oldest first. */
export async function listResumes(owner: Owner, now = Date.now()): Promise<Resume[]> {
  const docs = await resumes()
    .find({ owner, createdAt: { $gt: new Date(now - LISTED_FOR_MS) } })
    .sort({ createdAt: 1 })
    .toArray();
  return docs.map((d) => toResume(d, now));
}

/** Whether a resume of the session is under way, so it isn't deleted meanwhile. */
export async function resumeUnderWay(owner: Owner, sessionId: string, now = Date.now()) {
  const open = await resumes().findOne(
    { owner, sessionId, status: { $in: ['waiting', 'starting'] } },
    { sort: { createdAt: -1 } },
  );
  return open !== null && underWay(toResume(open, now));
}

/**
 * Withdraws a resume no machine has taken yet. False when the owner has no such resume waiting:
 * once a machine took it, Claude Code may already be starting it.
 */
export async function cancelResume(owner: Owner, id: string, now = Date.now()): Promise<boolean> {
  const result = await resumes().updateOne(
    {
      _id: id,
      owner,
      status: 'waiting',
      createdAt: { $gt: new Date(now - RESUME_WAIT_MS) },
    },
    { $set: { status: 'cancelled' } },
  );
  if (!result.modifiedCount) return false;
  changed(owner);
  return true;
}

/**
 * Hands the resumes waiting for `machine` to a plugin there, each once, oldest first. With the
 * machine's token (`device`), only those that machine may take.
 */
export async function claimResumes(
  owner: Owner,
  machine: string,
  device: string | undefined,
  now = Date.now(),
  max = 5,
): Promise<ClaimedResume[]> {
  const claimed: ClaimedResume[] = [];
  while (claimed.length < max) {
    const doc = await resumes().findOneAndUpdate(
      {
        owner,
        machine,
        status: 'waiting',
        createdAt: { $gt: new Date(now - RESUME_WAIT_MS) },
        ...(device ? { $or: [{ device: { $exists: false } }, { device }] } : {}),
      },
      { $set: { status: 'starting', claimedAt: new Date(now) } },
      { sort: { createdAt: 1 } },
    );
    if (!doc) break;
    claimed.push({ id: doc._id, sessionId: doc.sessionId, ...(doc.cwd ? { cwd: doc.cwd } : {}) });
  }
  if (claimed.length) changed(owner);
  return claimed;
}

/** What the plugin said of a resume it took. False when the owner has no such resume starting. */
export async function finishResume(
  owner: Owner,
  id: string,
  { ok, reason, detail }: ResumeResult,
  now = Date.now(),
): Promise<boolean> {
  const result = await resumes().updateOne(
    { _id: id, owner, status: 'starting' },
    {
      $set: ok
        ? { status: 'started', startedAt: new Date(now) }
        : {
            status: 'failed',
            reason: reason || "Claude Code didn't start it",
            ...(detail ? { detail } : {}),
          },
    },
  );
  if (!result.matchedCount) return false;
  changed(owner);
  return true;
}

/** Deletes the resumes of a deleted session. */
export async function forgetResumes(owner: Owner, sessionId: string): Promise<void> {
  const res = await resumes().deleteMany({ owner, sessionId });
  if (res.deletedCount) changed(owner);
}

import { EventEmitter, once } from 'node:events';
import { getDb } from '@joc/db';
import { Answer } from '@joc/protocol';
import { type Owner, sessionKey } from './owner.ts';

// Answers to what a session waits on (a question, a permission request), from the dashboard, for
// the session's plugin to take. One per wait: the first answer wins, and the plugin takes it
// once. The plugin's poll is held open until an answer arrives, so it lands within moments.

interface AnswerDoc {
  /** `owner/sessionId/waitingId`: one answer per wait. */
  _id: string;
  owner: string;
  sessionId: string;
  waitingId: string;
  /** The Answer as JSON: question texts as keys would make awkward field names. */
  answer: string;
  createdAt: Date;
  claimedAt?: Date;
}

const answers = () => getDb().collection<AnswerDoc>('answers');

const answerKey = (owner: Owner, sessionId: string, waitingId: string) =>
  `${sessionKey(owner, sessionId)}/${waitingId}`;

/** Wakes a held poll as soon as its answer is saved. The server runs one replica. */
const arrivals = new EventEmitter().setMaxListeners(0);

/** Saves the answer to a wait; false when it already has one. */
export async function saveAnswer(
  owner: Owner,
  sessionId: string,
  waitingId: string,
  answer: Answer,
): Promise<boolean> {
  const _id = answerKey(owner, sessionId, waitingId);
  try {
    await answers().insertOne({
      _id,
      owner,
      sessionId,
      waitingId,
      answer: JSON.stringify(answer),
      createdAt: new Date(),
    });
  } catch (error) {
    if (isDuplicateKey(error)) return false;
    throw error;
  }
  arrivals.emit(_id);
  return true;
}

/** Takes the wait's answer if there is one not yet taken. */
export async function claimAnswer(
  owner: Owner,
  sessionId: string,
  waitingId: string,
): Promise<Answer | undefined> {
  const doc = await answers().findOneAndUpdate(
    { _id: answerKey(owner, sessionId, waitingId), owner, claimedAt: { $exists: false } },
    { $set: { claimedAt: new Date() } },
  );
  if (!doc) return undefined;
  const parsed = Answer.safeParse(JSON.parse(doc.answer));
  return parsed.success ? parsed.data : undefined;
}

/** How often a held poll looks again, in case a wake-up was missed. */
const RECHECK_MS = 1000;

/**
 * Takes the wait's answer, waiting up to `waitMs` for one to arrive. Undefined when none came,
 * or when `signal` (the request going away, the server shutting down) ended the wait.
 */
export async function waitForAnswer(
  owner: Owner,
  sessionId: string,
  waitingId: string,
  waitMs: number,
  signal: AbortSignal,
): Promise<Answer | undefined> {
  const key = answerKey(owner, sessionId, waitingId);
  const end = Date.now() + waitMs;
  for (;;) {
    const answer = await claimAnswer(owner, sessionId, waitingId);
    const left = end - Date.now();
    if (answer || left <= 0 || signal.aborted) return answer;
    const pause = AbortSignal.any([signal, AbortSignal.timeout(Math.min(left, RECHECK_MS))]);
    // Rejects when the pause ends without an answer; the loop looks again either way.
    await once(arrivals, key, { signal: pause }).catch(() => undefined);
  }
}

/** Forgets a wait's answer once the wait is over, whether or not it was taken. */
export async function dropAnswer(owner: Owner, sessionId: string, waitingId: string) {
  await answers().deleteOne({ _id: answerKey(owner, sessionId, waitingId), owner });
}

/** Deletes a deleted session's answers. */
export async function forgetAnswers(owner: Owner, sessionId: string): Promise<void> {
  await answers().deleteMany({ owner, sessionId });
}

function isDuplicateKey(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}

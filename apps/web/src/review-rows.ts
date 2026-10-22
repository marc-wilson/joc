import type { Launch, Session } from '@joc/protocol';
import { launchStatus } from './launches.ts';
import { plain } from './plain.ts';
import { activeAt, reviewDone } from './sessions.ts';
import { age } from './time.ts';

/** A finished review leaves the list this long after it finished. It stays in the history. */
export const REVIEW_LINGER_MS = 30 * 60_000;

/** A finished review you cleared, or that finished long enough ago: off the list. */
export function reviewGone(s: Session, dismissed: string[], now: number): boolean {
  if (!s.review || !reviewDone(s)) return false;
  return dismissed.includes(s.id) || now - activeAt(s) > REVIEW_LINGER_MS;
}

/** The PR, short and in full: "atlas-web#512", "harbor-labs/atlas-web#512". */
export function prLabels(review: { repo: string; number: number }): {
  short: string;
  full: string;
} {
  const name = review.repo.split('/').pop() ?? review.repo;
  return { short: `${name}#${review.number}`, full: `${review.repo}#${review.number}` };
}

/** Claude's last words without an opening outcome the tag already says: "Approved: ..." */
function afterOutcome(text: string | undefined): string | undefined {
  const rest = text?.replace(/^(?:approved|changes requested|requested changes)\b[\s:.,;-]*/i, '');
  return rest || undefined;
}

/** What a review row shows, beside its state. */
export interface ReviewRowText {
  done: boolean;
  /** The PR's title when JOC has it from GitHub, else the session's. */
  title: string;
  pr: string;
  prTitle: string;
  time: string;
  /** Live: what it's doing. Finished: Claude's last words, unless the session just ended. */
  activity?: string;
}

export function reviewRowText(
  s: Session,
  activity: string | undefined,
  now: number,
): ReviewRowText | undefined {
  const review = s.review;
  if (!review) return undefined;
  const { short, full } = prLabels(review);
  const done = reviewDone(s);
  const doneAt = new Date(activeAt(s)).toISOString();
  return {
    done,
    title: s.title ?? `Review ${full}`,
    pr: short,
    prTitle: full,
    time: done ? `Done ${age(doneAt, now)}` : age(s.updatedAt, now),
    activity: done ? (s.state === 'offline' ? undefined : afterOutcome(activity)) : activity,
  };
}

/** One row of a PR page's "Reviews from JOC": a review session, or a launch still without one. */
export interface PRReviewRow {
  key: string;
  title: string;
  /** The session, once there is one. */
  sessionId?: string;
  state: Session['state'];
  /** A cross when it couldn't start, a check once Claude said how the review went. */
  result?: 'pass' | 'fail';
  status: string;
  time: string;
  /** For the order: newest first. */
  at: number;
}

/**
 * Every review of one PR JOC knows of, newest first: the sessions that review it (started with the
 * Review button or a review command such as `/code-review 512`), live or in the history, and the
 * Review-button launches that haven't reported a session yet or couldn't start one.
 */
export function prReviewRows(
  pr: { repo: string; number: number },
  sessions: Session[],
  history: Session[],
  launches: Launch[],
  now: number,
): PRReviewRow[] {
  const ofPR = (s: Session) => s.review?.repo === pr.repo && s.review.number === pr.number;
  const byId = new Map<string, Session>();
  // A live copy is newer than the history's.
  for (const s of [...history, ...sessions]) if (ofPR(s)) byId.set(s.id, s);
  const rows: PRReviewRow[] = [...byId.values()].map((s) => {
    const done = reviewDone(s);
    // Once the session ended, its activity only says so: Claude's last words are kept apart.
    const text = s.state === 'offline' ? s.lastWords : s.activity;
    const said = text ? plain(text) : undefined;
    const outcome = s.review?.outcome;
    const words = done ? afterOutcome(said) : said;
    return {
      key: s.id,
      title: s.title ?? `Review #${pr.number}`,
      sessionId: s.id,
      state: s.state,
      ...(done && outcome ? { result: 'pass' as const } : {}),
      status:
        [outcome, words].filter(Boolean).join(' · ') ||
        (s.state === 'offline' ? 'Session ended' : done ? 'Finished' : 'Reviewing'),
      time: age(new Date(done ? activeAt(s) : Date.parse(s.updatedAt)).toISOString(), now),
      at: Date.parse(s.startedAt),
    };
  });
  for (const launch of launches) {
    if (launch.review?.repo !== pr.repo || launch.review.number !== pr.number) continue;
    if (launch.sessionId && byId.has(launch.sessionId)) continue;
    // Its session, should that not say it reviews (a server from before #65).
    const session = [...sessions, ...history].find((s) => s.id === launch.sessionId);
    rows.push({
      key: launch.id,
      title: session?.title ?? `Review #${pr.number}`,
      ...(session ? { sessionId: session.id } : {}),
      state: session?.state ?? 'idle',
      ...(launch.status === 'failed' ? { result: 'fail' as const } : {}),
      status: launchStatus(launch, session),
      time: age(launch.createdAt, now),
      at: Date.parse(launch.createdAt),
    });
  }
  return rows.sort((a, b) => b.at - a.at);
}

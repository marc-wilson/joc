import type { PullRequest, Session } from '@joc/protocol';
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
  prs: PullRequest[],
  activity: string | undefined,
  now: number,
): ReviewRowText | undefined {
  const review = s.review;
  if (!review) return undefined;
  const { short, full } = prLabels(review);
  const pr = prs.find((p) => p.repo === review.repo && p.number === review.number);
  const done = reviewDone(s);
  const doneAt = new Date(activeAt(s)).toISOString();
  return {
    done,
    title: pr?.title ?? s.title ?? `Review ${full}`,
    pr: short,
    prTitle: full,
    time: done ? `Done ${age(doneAt, now)}` : age(s.updatedAt, now),
    activity: done ? (s.state === 'offline' ? undefined : afterOutcome(activity)) : activity,
  };
}

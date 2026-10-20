import type { PullRequest, Review, Session } from '@joc/protocol';
import { sameWork } from './links.ts';

/** The PR's page in JOC. */
export const prHref = (pr: Pick<PullRequest, 'repo' | 'number'>) =>
  `/pr?${new URLSearchParams({ repo: pr.repo, number: String(pr.number) })}`;

/** The PR a `/pr?repo=&number=` address names, if it names one. */
export function prFromSearch(search: string): { repo: string; number: number } | undefined {
  const params = new URLSearchParams(search);
  const repo = params.get('repo');
  const number = Number(params.get('number'));
  return repo && Number.isInteger(number) && number > 0 ? { repo, number } : undefined;
}

/** The PR among the person's lists, wherever it shows. */
export function findPR(
  lists: PullRequest[][],
  pr: { repo: string; number: number },
): PullRequest | undefined {
  return lists.flat().find((p) => p.repo === pr.repo && p.number === pr.number);
}

/**
 * The live sessions a review can run in or start from: open ones on the PR's repo, which have a
 * checkout of it. Ones on the PR's own branch come first, then the rest in first-seen order.
 */
export function reviewSessions(pr: PullRequest, sessions: Session[]): Session[] {
  const open = sessions.filter((s) => s.repo === pr.repo && s.state !== 'offline');
  return [...open.filter((s) => sameWork(pr, s)), ...open.filter((s) => !sameWork(pr, s))];
}

/** One line on where a review stands, beside its session. */
export function reviewStatus(review: Review, session: Session | undefined): string {
  if (review.status === 'failed') return review.detail ?? "Couldn't start the session.";
  if (review.status === 'starting') return 'Waiting for the session on this repo to start it';
  if (!session) {
    return review.kind === 'new' ? 'Started. Waiting for it to report' : 'Sent to the session';
  }
  return review.kind === 'new' ? 'Running in a new session' : 'Sent to the session';
}

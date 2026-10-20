import { z } from 'zod';

// A session that reviews a pull request: started from JOC's Review button (its launch names the
// PR), or one whose first prompt is a review command on a PR, such as `/code-review 512` or
// `/prep-pr https://github.com/harbor-labs/atlas-web/pull/512`. The dashboard lists these apart.

/** How a review ended, as the PR review tags name it. */
export const ReviewOutcome = z.enum(['Approved', 'Changes requested', 'Commented']);
export type ReviewOutcome = z.infer<typeof ReviewOutcome>;

/** The pull request a session reviews, and how the review ended once Claude said. */
export const SessionReview = z.object({
  /** GitHub `owner/name`. */
  repo: z.string().min(1).max(200),
  number: z.number().int().positive(),
  url: z.url().max(500).optional(),
  outcome: ReviewOutcome.optional(),
});
export type SessionReview = z.infer<typeof SessionReview>;

const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\b/;

/** A command that reviews: `/code-review`, `/review`, `/review-pr`, `/prep-pr`, ... */
const REVIEW_COMMAND = /^\/(?:[\w:-]*review[\w:-]*|prep-pr)$/i;

/**
 * The PR a session's first prompt reviews, if it is a review command on one: the command, then a
 * PR number (on the session's own repo) or a PR's address. Anything else isn't a review.
 */
export function reviewOfPrompt(
  prompt: string | undefined,
  repo: string,
): Omit<SessionReview, 'outcome'> | undefined {
  const [command, target] = prompt?.trim().split(/\s+/) ?? [];
  if (!command || !target || !REVIEW_COMMAND.test(command)) return undefined;
  const url = target.match(PR_URL);
  if (url?.[1] && url[2]) {
    return { repo: url[1], number: Number(url[2]), url: url[0] };
  }
  const number = target.match(/^#?(\d+)$/)?.[1];
  // Only a GitHub repo has PRs; outside one, `repo` is a folder name.
  return number && repo.includes('/') ? { repo, number: Number(number) } : undefined;
}

/**
 * How a review ended, from the first line of Claude's last message, when it says; undefined when
 * it doesn't.
 */
export function reviewOutcome(text: string | undefined): ReviewOutcome | undefined {
  if (!text) return undefined;
  if (/\b(?:changes requested|request(?:ed|ing)? changes)\b/i.test(text)) {
    return 'Changes requested';
  }
  if (
    /\b(?:approved|approving|lgtm)\b/i.test(text) &&
    !/(?:\bnot|n't|\bnever)\s+(?:yet\s+)?(?:be\s+)?approv/i.test(text)
  ) {
    return 'Approved';
  }
  if (
    /\b(?:comments? posted|posted (?:\d+ |a )?comments?|left (?:\d+ |a )?comments?)\b/i.test(text)
  ) {
    return 'Commented';
  }
  return undefined;
}

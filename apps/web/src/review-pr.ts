// What a review session's pull request view works out from the session and its conversation:
// Claude's review steps so far, the review it posted, and what Claude said of it.
import type { ConversationItem, PullRequest, Session } from '@joc/protocol';
import { plain } from './plain.ts';

export interface ReviewStep {
  /** Plain words; `code` is shown in mono after them. */
  text: string;
  code?: string;
  status: 'done' | 'now' | 'next';
}

const READS = new Set(['Read', 'NotebookRead']);

/**
 * The review's steps, from what the conversation shows: fetched, checked out, read, the current
 * step while the session works, then drafting and posting. Posting is done once Claude said how
 * the review ended.
 */
export function reviewSteps(
  session: Session,
  pull: PullRequest | undefined,
  items: ConversationItem[],
): ReviewStep[] {
  const number = session.review?.number;
  const calls = items.flatMap((i) => (i.kind === 'tool_call' ? [i] : []));
  const posted = !!session.review?.outcome;
  const read = new Set(calls.filter((c) => READS.has(c.name)).map((c) => c.summary)).size;
  const branch = pull?.branch;
  const checkedOut =
    (!!branch && session.branch === branch) ||
    calls.some((c) => /\b(?:gh pr checkout|git (?:checkout|switch))\b/.test(c.summary));
  const steps: ReviewStep[] = [
    { text: `Fetched #${number}`, status: calls.length || posted ? 'done' : 'next' },
    {
      text: 'Checked out',
      code: branch,
      status: checkedOut || posted ? 'done' : 'next',
    },
    {
      text: read ? `Read ${read} ${read === 1 ? 'file' : 'files'}` : 'Read the changes',
      status: read || posted ? 'done' : 'next',
    },
  ];
  if (!posted && session.state === 'working') {
    const last = calls.at(-1);
    steps.push(
      last && last.name === 'Bash'
        ? { text: 'Running', code: last.summary.slice(0, 80), status: 'now' }
        : { text: plain(session.activity ?? 'Working').slice(0, 80), status: 'now' },
    );
  }
  steps.push(
    { text: 'Draft review', status: posted ? 'done' : 'next' },
    { text: 'Post to GitHub', status: posted ? 'done' : 'next' },
  );
  return steps;
}

/** The person's own latest review of the pull request on GitHub, if GitHub lists one. */
export function yourReview(pull: PullRequest | undefined, you: string | undefined) {
  if (!pull || !you) return undefined;
  const mine = (pull.reviews ?? []).filter((r) => r.by.login.toLowerCase() === you.toLowerCase());
  return mine.at(-1);
}

/** What Claude said of its review: the first paragraph of its last message, in plain words. */
export function verdictSummary(items: ConversationItem[]): string | undefined {
  const last = items.findLast((i) => i.kind === 'claude');
  if (last?.kind !== 'claude') return undefined;
  const paragraph = last.text
    .split(/\n\s*\n/)
    .map((p) => plain(p).trim())
    .find(Boolean);
  if (!paragraph) return undefined;
  return paragraph.length > 400 ? `${paragraph.slice(0, 399)}…` : paragraph;
}

/** Whether the pull request ended before Claude posted its review. */
export const notPosted = (session: Session, pull: PullRequest | undefined) =>
  !session.review?.outcome && (pull?.state === 'merged' || pull?.state === 'closed');

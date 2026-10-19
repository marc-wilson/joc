import type { GitHubNotification, PullRequest, Session } from '@joc/protocol';

// Sessions and pull requests belong together when they're on the same repo and branch.

type Work = Pick<Session, 'repo' | 'branch'>;

export const sameWork = (a: Work, b: Work) => a.repo === b.repo && a.branch === b.branch;

/** The most recently active of the live sessions on a repo and branch. */
function latestOn(work: Work, sessions: Session[]) {
  return sessions
    .filter((s) => sameWork(work, s))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
}

/** The live session working on a PR's branch: the most recently active, if several. */
export const sessionFor = (pr: PullRequest, sessions: Session[]): Session | undefined =>
  latestOn(pr, sessions);

/**
 * The live session on a notification's branch: a CI run's own, or a pull request's head
 * branch when it's one of the person's or waiting on their review.
 */
export function sessionForThread(
  thread: GitHubNotification,
  prs: PullRequest[],
  sessions: Session[],
): Session | undefined {
  const branch =
    thread.branch ??
    (thread.type === 'PullRequest'
      ? prs.find((pr) => pr.repo === thread.repo && pr.number === thread.number)?.branch
      : undefined);
  return branch ? latestOn({ repo: thread.repo, branch }, sessions) : undefined;
}

/** The PR a session's branch is in, if any. */
export const prFor = (session: Session, prs: PullRequest[]) =>
  prs.find((pr) => sameWork(pr, session));

/** A shell command that resumes the session in its own folder. */
export function resumeCommand(session: Pick<Session, 'id' | 'cwd'>): string {
  const resume = `claude --resume ${session.id}`;
  if (!session.cwd) return resume;
  // Single quotes keep spaces and $ literal; a quote in the path is closed, escaped and reopened.
  return `cd '${session.cwd.replaceAll("'", `'\\''`)}' && ${resume}`;
}

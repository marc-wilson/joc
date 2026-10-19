import type { PullRequest, Session } from '@joc/protocol';

// Sessions and pull requests belong together when they're on the same repo and branch.

export const sameWork = (pr: PullRequest, session: Pick<Session, 'repo' | 'branch'>) =>
  pr.repo === session.repo && pr.branch === session.branch;

/** The live session working on a PR's branch: the most recently active, if several. */
export function sessionFor(pr: PullRequest, sessions: Session[]): Session | undefined {
  return sessions
    .filter((s) => sameWork(pr, s))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
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

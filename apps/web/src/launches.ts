import type { Launch, Session } from '@joc/protocol';

/**
 * The live session a new one starts from, in its folder: among `candidates`, one on `branch`
 * first, then the first that's still running. None when every one is offline.
 */
export function launchFrom(candidates: Session[], branch?: string): Session | undefined {
  const live = candidates.filter((s) => s.state !== 'offline');
  return live.find((s) => branch !== undefined && s.branch === branch) ?? live[0];
}

/** The new session a launch started, once it reports. */
export const launched = (launch: Launch | undefined, sessions: Session[]) =>
  launch?.sessionId ? sessions.find((s) => s.id === launch.sessionId) : undefined;

/** One line on where a launch stands. */
export function launchStatus(launch: Launch, session: Session | undefined): string {
  if (launch.status === 'failed') return launch.detail ?? "Couldn't start the session.";
  if (launch.status === 'starting') return 'Waiting for the session on this repo to start it';
  if (session)
    return session.state === 'offline' ? 'Ran in a new session' : 'Running in a new session';
  return launch.sessionId ? 'Started. Waiting for it to report' : "Started, but JOC can't see it";
}

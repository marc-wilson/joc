import { ClaudeSessionId, type Deletion, type Session } from '@joc/protocol';
import { isQuiet } from './session-list.ts';

// Deleting ended sessions: on their machine (gone from `claude --resume`) and in JOC. A running
// session on the machine does it, so the dashboard says plainly when there is none.

export const STILL_RUNNING = 'Still running. Quit it first.';

/** Why the session can't be deleted now; undefined when it can. */
export function cantDelete(s: Session, now = Date.now()): string | undefined {
  if (!ClaudeSessionId.safeParse(s.id).success) return 'Not a Claude Code session JOC can delete.';
  if (!s.machine) return "JOC doesn't know which machine it ran on.";
  if (s.state !== 'offline' && !isQuiet(s, now)) return STILL_RUNNING;
  return undefined;
}

/** The newest delete asked for the session, if any. */
export function deletionOf(deletes: Deletion[], sessionId: string): Deletion | undefined {
  return deletes.findLast((d) => d.sessionId === sessionId);
}

/** Whether a Claude Code session still reports from the machine: one there can take a delete. */
export function machineLive(sessions: Session[], machine: string, now = Date.now()): boolean {
  return sessions.some((s) => s.machine === machine && s.state !== 'offline' && !isQuiet(s, now));
}

/** One line on where a delete stands; undefined once it's done. */
export function deletionLine(d: Deletion, live: boolean): string | undefined {
  if (d.status === 'deleted') return undefined;
  if (d.status === 'failed') return `Couldn't delete it. ${d.detail ?? ''}`.trim();
  if (d.status === 'waiting' && !live) return `Start Claude Code on ${d.machine} to delete it.`;
  return `Deleting on ${d.machine}…`;
}

/** The line a deleted row fades to. */
export const removedLine = (machine: string | undefined) =>
  machine ? `Deleted from ${machine} and JOC` : 'Deleted';

/** The machines a set of sessions ran on, for the confirm dialog: "harbor-mbp", "2 machines". */
export function machinesOf(sessions: Session[]): string {
  const machines = [...new Set(sessions.map((s) => s.machine ?? 'its machine'))];
  return machines.length === 1 ? (machines[0] ?? 'its machine') : `${machines.length} machines`;
}

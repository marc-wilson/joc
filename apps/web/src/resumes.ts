import type { Resume, Session } from '@joc/protocol';
import { cantDelete, machineLive } from './deletes.ts';
import { isQuiet } from './session-list.ts';

// Resuming an ended session (issue #68): a running session on the machine runs
// `claude --bg --resume <id>`, and the session comes back under its own id. The dashboard says
// how far it got, and plainly when no session on the machine can take it.

/** A step of starting back up, as `ResumeSteps` in @joc/ui draws it. */
export interface ResumeStep {
  label: string;
  mono?: boolean;
  status: 'done' | 'pending' | 'todo';
}

/**
 * Where a session's latest resume stands:
 * - `none`: never asked, or withdrawn.
 * - `waiting`: for a session on the machine to take it.
 * - `starting`: a machine took it and runs `claude --resume`.
 * - `loading`: Claude Code runs it again; waiting for its plugin to report.
 * - `live`: it reported since: it's back.
 * - `failed`: it didn't start.
 */
export type ResumePhase = 'none' | 'waiting' | 'starting' | 'loading' | 'live' | 'failed';

/** Why the session can't be resumed now; undefined when it can. The same as for deleting. */
export const cantResume = (s: Session, now = Date.now()) => cantDelete(s, now);

/**
 * Whether the session has ended, as far as the dashboard can tell: Claude Code said so, or it went
 * quiet while another session on its machine still reports, so the machine is up and this one
 * stopped. A quiet session on a machine that went quiet too may still be running (a laptop
 * asleep): it keeps its state, and Resume waits until it's known to have ended.
 */
export function hasEnded(s: Session, sessions: Session[], now = Date.now()): boolean {
  if (s.state === 'offline') return true;
  return isQuiet(s, now) && !!s.machine && machineLive(sessions, s.machine, now);
}

/** The newest resume asked for the session, if any. */
export function resumeOf(resumes: Resume[], sessionId: string): Resume | undefined {
  return resumes.findLast((r) => r.sessionId === sessionId);
}

/** Where the resume stands for the session as it is now. */
export function resumePhase(r: Resume | undefined, s: Session | undefined): ResumePhase {
  if (!r || r.status === 'cancelled') return 'none';
  if (r.status !== 'started') return r.status;
  // Any report since it was asked for means it ran again: it's back, or it ended once more.
  if (!s || Date.parse(s.updatedAt) <= Date.parse(r.createdAt)) return 'loading';
  return s.state === 'offline' ? 'none' : 'live';
}

/** Whether a resume is under way: the session shows "Starting…" and can't be resumed again. */
export const underWay = (phase: ResumePhase) =>
  phase === 'waiting' || phase === 'starting' || phase === 'loading';

/** The command a resume runs, short as the dashboard shows it. */
export const resumeLine = (sessionId: string) => `claude --resume ${sessionId.slice(0, 8)}`;

/** The three steps of starting back up: reach the machine, `claude --resume`, load the messages. */
export function resumeSteps(
  phase: ResumePhase,
  machine: string,
  sessionId: string,
  messages: number,
): ResumeStep[] {
  const reached = phase === 'starting' || phase === 'loading';
  return [
    {
      label: reached ? `Reached ${machine}` : `Reaching ${machine}`,
      status: reached ? 'done' : 'pending',
    },
    {
      label: resumeLine(sessionId),
      mono: true,
      status: phase === 'loading' ? 'done' : phase === 'starting' ? 'pending' : 'todo',
    },
    {
      label: `Load ${messages} ${messages === 1 ? 'message' : 'messages'}`,
      status: phase === 'loading' ? 'pending' : 'todo',
    },
  ];
}

/** "Couldn't resume on harbor-mbp: session file not found". */
export const failureTitle = (r: Resume) =>
  `Couldn't resume on ${r.machine}: ${r.reason ?? "Claude Code didn't start it"}`;

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** "Resumed at 10:42 on harbor-mbp", once it's back. */
export const resumedLine = (r: Resume) =>
  `Resumed at ${clock(r.startedAt ?? r.createdAt)} on ${r.machine}`;

/** One line on where a resume stands, for a History row or the composer; undefined if none. */
export function resumeStatus(phase: ResumePhase, r: Resume | undefined, live: boolean) {
  if (!r || phase === 'none') return undefined;
  if (phase === 'failed') return failureTitle(r);
  if (phase === 'live') return resumedLine(r);
  if (phase === 'waiting' && !live) return `Start Claude Code on ${r.machine} to resume it`;
  return `Starting on ${r.machine}…`;
}

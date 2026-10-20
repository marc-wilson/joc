import type { Resume, Session } from '@joc/protocol';
import { Button, type ComposerResume, OverflowMenu, resumeCommand, SessionLink } from '@joc/ui';
import { type ReactNode, useState } from 'react';
import { machineLive, STILL_RUNNING } from './deletes.ts';
import { askResume, withdrawResume } from './hooks.ts';
import {
  cantResume,
  failureTitle,
  type ResumePhase,
  resumedLine,
  resumeOf,
  resumePhase,
  resumeStatus,
  resumeSteps,
  underWay,
} from './resumes.ts';
import { ago } from './time.ts';

/** What an ended session's pane shows of resuming it: the tag, Resume, the composer, a divider. */
export interface ResumeView {
  phase: ResumePhase;
  /** "Ended" or "Starting…" in place of the state badge; undefined while it's live. */
  tag?: string;
  /** The header's Resume, when it can be resumed now. */
  canResume: boolean;
  resume: () => void;
  /** The composer's Resume, steps or failure, while it's ended. */
  composer?: ComposerResume;
  /** A line across the conversation, and when: at the end while it starts, then where it resumed. */
  divider?: { text: string; at?: string };
}

/** The machines the person's sessions ran on, for the picker; offline ones can't be picked. */
function machinesFor(session: Session, sessions: Session[], now: number) {
  const names = [
    ...new Set([session.machine, ...sessions.map((s) => s.machine)].filter(Boolean)),
  ] as string[];
  return names.map((name) => ({
    name,
    // Its own machine can always be asked: it waits there for Claude Code to start.
    offline: name !== session.machine && !machineLive(sessions, name, now),
  }));
}

/** Resuming the session in the pane: where it stands, and what each part of the pane shows. */
export function useResumeView(
  session: Session | undefined,
  resumes: Resume[],
  sessions: Session[],
  messages: number,
  now: number,
): ResumeView | undefined {
  const [busy, setBusy] = useState(false);
  // A request the server refused, by session.
  const [refused, setRefused] = useState<{ id: string; error: string }>();
  // The machine picked, by session.
  const [picked, setPicked] = useState<ReadonlyMap<string, string>>(new Map());
  if (!session) return undefined;

  const r = resumeOf(resumes, session.id);
  const phase = resumePhase(r, session);
  const own = r && (phase === 'failed' || underWay(phase)) ? r.machine : session.machine;
  const machine = picked.get(session.id) ?? own ?? 'its machine';
  const error = refused?.id === session.id ? refused.error : undefined;

  async function resume() {
    if (!session) return;
    setBusy(true);
    setRefused(undefined);
    const outcome = await askResume(session.id, picked.get(session.id));
    setBusy(false);
    if ('error' in outcome) setRefused({ id: session.id, error: outcome.error });
  }

  const machines = machinesFor(session, sessions, now);
  const picker =
    machines.length > 1 ? (
      <OverflowMenu
        label={`Machine: ${machine}`}
        trigger={machine}
        above
        items={machines.map((m) => ({
          id: m.name,
          label: m.name,
          checked: m.name === machine,
          disabledReason: m.offline ? 'Offline' : undefined,
          onSelect: () => setPicked((p) => new Map(p).set(session.id, m.name)),
        }))}
      />
    ) : undefined;

  const ended = session.state === 'offline';
  const going = underWay(phase);
  let composer: ComposerResume | undefined;
  if (ended && going && r) {
    const live = machineLive(sessions, r.machine, now);
    composer = {
      phase: 'starting',
      machine: r.machine,
      text:
        phase === 'waiting' && !live
          ? `Start Claude Code on ${r.machine} to resume it.`
          : `Starting on ${r.machine}…`,
      steps: resumeSteps(phase, r.machine, session.id, messages),
      onCancel: phase === 'waiting' ? () => void withdrawResume(r.id) : undefined,
    };
  } else if (ended && (error || (phase === 'failed' && r))) {
    composer = {
      phase: 'failed',
      machine,
      picker,
      error: {
        title: error ? `Couldn't resume on ${machine}` : r ? failureTitle(r) : '',
        detail: error ?? r?.detail,
        command: resumeCommand(session.id, session.cwd),
      },
      onResume: () => void resume(),
      busy,
    };
  } else if (ended) {
    composer = {
      phase: 'ended',
      machine,
      picker,
      text: `This session ended ${ago(session.updatedAt, now)}. Resume it to keep going.`,
      onResume: () => void resume(),
      busy,
    };
  }

  return {
    phase,
    tag: going ? 'Starting…' : ended ? 'Ended' : undefined,
    canResume: !going && !cantResume(session, now),
    resume: () => void resume(),
    composer,
    divider:
      going && r
        ? { text: `Resuming on ${r.machine}` }
        : phase === 'live' && r
          ? { text: resumedLine(r), at: r.startedAt ?? r.createdAt }
          : undefined,
  };
}

/** A History row's resume: its status line, and Resume, "Starting…", Try again or Open session. */
export function historyResume(
  session: Session,
  resumes: Resume[],
  sessions: Session[],
  now: number,
  onResume: () => void,
) {
  const r = resumeOf(resumes, session.id);
  const phase = resumePhase(r, session);
  const status = resumeStatus(phase, r, r ? machineLive(sessions, r.machine, now) : false);
  let action: ReactNode = null;
  if (underWay(phase)) {
    action = (
      <Button variant="secondary" size="md" disabled>
        Starting…
      </Button>
    );
  } else if (phase === 'failed') {
    action = (
      <Button variant="secondary" size="md" onClick={onResume}>
        Try again
      </Button>
    );
  } else if (!cantResume(session, now)) {
    action = (
      <Button variant="secondary" size="md" onClick={onResume}>
        Resume
      </Button>
    );
  } else if (cantResume(session, now) === STILL_RUNNING) {
    // Running, or back: open it in the dashboard instead.
    action = (
      <SessionLink
        title="Open session"
        state={session.state}
        href={`/?session=${encodeURIComponent(session.id)}`}
      />
    );
  }
  return { phase, status, failed: phase === 'failed', action };
}

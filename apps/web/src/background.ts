import type { ConversationItem, RunningTask, Session, SessionState } from '@joc/protocol';
import { plain } from './plain.ts';

type Call = Extract<ConversationItem, { kind: 'tool_call' }>;
type Result = Extract<ConversationItem, { kind: 'tool_result' }>;
type Update = Extract<ConversationItem, { kind: 'task_update' }>;

/**
 * A background shell command or subagent, as far as the transcript tells; or other work Claude
 * Code lists as running (a teammate, a monitor, a workflow, a scheduled wakeup).
 */
export interface BackgroundTask {
  id: string;
  /** Claude Code's id for it: a shell's task id or an agent's id. */
  taskId?: string;
  kind: 'shell' | 'subagent';
  /** The subagent's type, for subagents. */
  label?: string;
  /** A teammate: a subagent, which the Team tab shows instead. */
  teammate?: boolean;
  title: string;
  /** The command's first line, for shells. */
  command?: string;
  /** The whole command, for shells, when it runs past one line. */
  fullCommand?: string;
  /** What it was asked, for subagents. */
  prompt?: string;
  /** Its final report, for subagents; or why it failed to start. */
  report?: string;
  /** The end of what it printed, for shells. */
  output?: string;
  /**
   * `running` until it ends; `pass`/`fail` once its outcome is known; `ended` when it stopped
   * without an outcome: killed, its session ended, or Claude Code never said.
   */
  status: 'running' | 'pass' | 'fail' | 'ended';
  /** One line on how it ended. */
  tail?: string;
  /** Unset for work only Claude Code's list knows of: it doesn't say when that started. */
  startedAt?: string;
  endedAt?: string;
}

const firstLine = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);

const STOPPED = /Successfully stopped task: ([\w-]+)/;

/**
 * The session's background work, in the order it started. A subagent that blocks the turn ends
 * with its tool result; a background shell or async subagent ends with a `task_update`.
 *
 * `listed` is Claude Code's own list of what runs, and the truth for it: a task the transcript
 * has no end for runs while the list has it, and has ended once a list newer than its start
 * leaves it out. Listed work the transcript doesn't show is added, after the rest. Without a list
 * (an older plugin) the transcript is all there is.
 */
export function backgroundTasks(
  items: ConversationItem[],
  sessionState: SessionState,
  listed?: Session['background'],
): BackgroundTask[] {
  const tasks = fromTranscript(items, sessionState);
  return listed ? withListed(tasks, listed, sessionState) : tasks;
}

function withListed(
  tasks: BackgroundTask[],
  listed: NonNullable<Session['background']>,
  sessionState: SessionState,
): BackgroundTask[] {
  const listedAt = Date.parse(listed.at);
  const ids = new Set(listed.tasks.map((t) => t.id));
  const matched = new Set<string>();
  const merged = tasks.map((t) => {
    const id = t.taskId && ids.has(t.taskId) ? t.taskId : ids.has(t.id) ? t.id : undefined;
    if (id) matched.add(id);
    // The transcript saying how it ended beats any list.
    if (t.status !== 'running' || id) return t;
    // Started after the latest list: that list can't know of it yet.
    if (!t.startedAt || Date.parse(t.startedAt) >= listedAt) return t;
    return { ...t, status: 'ended' as const, tail: 'Ended' };
  });
  const ended = sessionState === 'offline';
  for (const t of listed.tasks) {
    if (matched.has(t.id)) continue;
    merged.push({
      ...fromList(t),
      ...(ended ? { status: 'ended', tail: 'The session ended' } : { status: 'running' }),
    });
  }
  return merged;
}

const AGENT_TYPES = ['subagent', 'teammate', 'agent', 'workflow'];

/** Claude Code's list types that are teammates, for the Team tab. */
const TEAMMATE_TYPES = ['subagent', 'teammate', 'agent'];

const TYPE_LABELS: Record<string, string> = {
  monitor: 'Monitor',
  workflow: 'Workflow',
  teammate: 'Teammate',
  cron: 'Scheduled',
};

/** Work only Claude Code's list knows of, as a task. */
function fromList(t: RunningTask): Omit<BackgroundTask, 'status'> {
  const agent = AGENT_TYPES.includes(t.type);
  const label =
    t.type === 'shell'
      ? undefined
      : t.type === 'subagent'
        ? (t.agentType ?? 'Subagent')
        : (TYPE_LABELS[t.type] ?? `${t.type.charAt(0).toUpperCase()}${t.type.slice(1)}`);
  const command = t.command ?? t.schedule;
  const title =
    (t.description ? firstLine(t.description) : undefined) ??
    t.name ??
    (t.server && t.tool ? `${t.server} · ${t.tool}` : undefined) ??
    (command ? undefined : label) ??
    (t.type === 'shell' ? 'Background command' : 'Background task');
  return {
    id: t.id,
    taskId: t.id,
    kind: agent ? 'subagent' : 'shell',
    ...(label ? { label } : {}),
    ...(TEAMMATE_TYPES.includes(t.type) ? { teammate: true } : {}),
    title,
    ...(command ? { command: firstLine(command) } : {}),
    ...(command?.includes('\n') ? { fullCommand: command } : {}),
    ...(agent && t.description ? { prompt: t.description } : {}),
  };
}

function fromTranscript(items: ConversationItem[], sessionState: SessionState): BackgroundTask[] {
  const results = new Map<string, Result>();
  const updates = new Map<string, Update>();
  for (const i of items) {
    if (i.kind === 'tool_result') {
      results.set(i.toolUseId, i);
      // Claude Code sends no notification for a task stopped with TaskStop; its result says so.
      const stopped = STOPPED.exec(i.text)?.[1];
      if (stopped && !updates.has(stopped)) {
        updates.set(stopped, {
          id: i.id,
          at: i.at,
          kind: 'task_update',
          taskId: stopped,
          status: 'killed',
          summary: 'Stopped',
        });
      }
    }
    if (i.kind === 'task_update') {
      // The first word on a task is the one that ended it.
      if (i.toolUseId && !updates.has(i.toolUseId)) updates.set(i.toolUseId, i);
      if (!updates.has(i.taskId)) updates.set(i.taskId, i);
    }
  }

  const tasks: BackgroundTask[] = [];
  for (const call of items) {
    if (call.kind !== 'tool_call') continue;
    const result = results.get(call.toolUseId);
    if (!call.subagent && !call.background && !result?.taskId) continue;
    tasks.push({
      ...describe(call),
      ...(result?.taskId ? { taskId: result.taskId } : {}),
      ...outcome(call, result, updates, sessionState),
    });
  }
  return tasks;
}

function describe(
  call: Call,
): Pick<
  BackgroundTask,
  | 'id'
  | 'kind'
  | 'label'
  | 'teammate'
  | 'title'
  | 'command'
  | 'fullCommand'
  | 'prompt'
  | 'startedAt'
> {
  const base = { id: call.toolUseId, startedAt: call.at };
  if (call.subagent) {
    return {
      ...base,
      kind: 'subagent',
      label: call.subagent,
      teammate: true,
      title: call.description ?? (call.summary || 'Subagent'),
      ...(call.prompt ? { prompt: call.prompt } : {}),
    };
  }
  return {
    ...base,
    kind: 'shell',
    title: call.description ?? 'Background command',
    command: call.summary || undefined,
    ...(call.command ? { fullCommand: call.command } : {}),
  };
}

function outcome(
  call: Call,
  result: Result | undefined,
  updates: Map<string, Update>,
  sessionState: SessionState,
): Pick<BackgroundTask, 'status' | 'tail' | 'endedAt' | 'report' | 'output'> {
  const update =
    updates.get(call.toolUseId) ?? (result?.taskId ? updates.get(result.taskId) : undefined);
  if (update) {
    return {
      status:
        update.status === 'completed' ? 'pass' : update.status === 'failed' ? 'fail' : 'ended',
      tail: update.summary || (update.status === 'killed' ? 'Stopped' : undefined),
      endedAt: update.at,
      ...(update.result ? { report: update.result } : {}),
      ...(update.output ? { output: update.output } : {}),
    };
  }
  if (result && !result.taskId) {
    // Ended with its result: a blocking subagent, or a call that failed to start. A background
    // shell whose result names no task can't be followed further.
    const line = firstLine(result.text);
    const tail = line && plain(line);
    const report = result.text.trim() ? { report: result.text } : {};
    if (result.isError) return { status: 'fail', tail, endedAt: result.at, ...report };
    if (call.subagent && !call.background) {
      return { status: 'pass', tail, endedAt: result.at, ...report };
    }
    return { status: 'ended', tail: 'Claude Code did not report how it ended' };
  }
  if (sessionState === 'offline') return { status: 'ended', tail: 'The session ended' };
  return { status: 'running' };
}

/** A task's run time: "8s", "4m 12s", "2h 5m". */
export function elapsed(from: string, to: string | number): string {
  const end = typeof to === 'number' ? to : Date.parse(to);
  const s = Math.max(0, Math.floor((end - Date.parse(from)) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** The tasks the Background tab shows: everything but teammates, which have the Team tab. */
export const withoutTeammates = (tasks: BackgroundTask[]) => tasks.filter((t) => !t.teammate);

/** How many tasks run now. The Background tab, the session row and the header all count so. */
export function runningCount(tasks: BackgroundTask[]): number {
  return tasks.filter((t) => t.status === 'running').length;
}

/** The session row's line for a session whose work runs on in the background. */
export function runningLine(count: number): string {
  return `${count} background ${count === 1 ? 'task' : 'tasks'} running`;
}

/** Finished tasks shown before "Show all". */
export const FINISHED_SHOWN = 5;

/**
 * The tasks still running, in the order they started, then the finished ones, newest first.
 * `held` are kept with the running ones though they've ended, so a row doesn't move from under
 * the pointer.
 */
export function arrangeTasks(
  tasks: BackgroundTask[],
  held: readonly string[] = [],
): { running: BackgroundTask[]; finished: BackgroundTask[] } {
  const isRunning = (t: BackgroundTask) => t.status === 'running' || held.includes(t.id);
  const ended = (t: BackgroundTask) => Date.parse(t.endedAt ?? t.startedAt ?? '') || 0;
  return {
    running: tasks.filter(isRunning),
    finished: tasks.filter((t) => !isRunning(t)).sort((a, b) => ended(b) - ended(a)),
  };
}

/** What a subagent is doing now, one line, from its latest step. */
export function latestStep(steps: ConversationItem[]): string | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step?.kind === 'tool_call') return [step.name, step.summary].filter(Boolean).join(' ');
    if (step?.kind === 'claude') {
      const line = firstLine(step.text);
      if (line) return plain(line);
    }
  }
  return undefined;
}

/** A running task's time on a clock, which keeps its width as it ticks: "0:08", "4:12", "1:02:03". */
export function clock(from: string, to: string | number): string {
  const end = typeof to === 'number' ? to : Date.parse(to);
  const s = Math.max(0, Math.floor((end - Date.parse(from)) / 1000));
  const pad = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** One line in a subagent's steps. */
export interface Step {
  id: string;
  tool: string;
  target?: string;
  /** When it started, on the task's clock. */
  time: string;
  /** `current` is the step a running task is on now. */
  status: 'done' | 'fail' | 'current';
}

/** A subagent's tool calls as steps, each timed from when the task started. */
export function taskSteps(items: ConversationItem[], startedAt: string, running: boolean): Step[] {
  const results = new Map(
    items.flatMap((i) => (i.kind === 'tool_result' ? [[i.toolUseId, i] as const] : [])),
  );
  const calls = items.filter((i) => i.kind === 'tool_call');
  const last = calls.at(-1);
  return calls.map((call) => {
    const result = results.get(call.toolUseId);
    const status: Step['status'] = result?.isError
      ? 'fail'
      : !result && running && call === last
        ? 'current'
        : 'done';
    return {
      id: call.id,
      tool: call.name,
      ...(call.summary ? { target: call.summary } : {}),
      time: clock(startedAt, call.at),
      status,
    };
  });
}

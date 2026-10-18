import type { ConversationItem, SessionState } from '@joc/protocol';

type Call = Extract<ConversationItem, { kind: 'tool_call' }>;
type Result = Extract<ConversationItem, { kind: 'tool_result' }>;
type Update = Extract<ConversationItem, { kind: 'task_update' }>;

/** A background shell command or subagent, as far as the transcript tells. */
export interface BackgroundTask {
  id: string;
  kind: 'shell' | 'subagent';
  /** The subagent's type, for subagents. */
  label?: string;
  title: string;
  /** The command, for shells. */
  command?: string;
  /**
   * `running` until it ends; `pass`/`fail` once its outcome is known; `ended` when it stopped
   * without an outcome: killed, its session ended, or Claude Code never said.
   */
  status: 'running' | 'pass' | 'fail' | 'ended';
  /** One line on how it ended. */
  tail?: string;
  startedAt: string;
  endedAt?: string;
}

const firstLine = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);

/**
 * The session's background work, in the order it started. A subagent that blocks the turn ends
 * with its tool result; a background shell or async subagent ends with a `task_update`.
 */
export function backgroundTasks(
  items: ConversationItem[],
  sessionState: SessionState,
): BackgroundTask[] {
  const results = new Map<string, Result>();
  const updates = new Map<string, Update>();
  for (const i of items) {
    if (i.kind === 'tool_result') results.set(i.toolUseId, i);
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
    tasks.push({ ...describe(call), ...outcome(call, result, updates, sessionState) });
  }
  return tasks;
}

function describe(
  call: Call,
): Pick<BackgroundTask, 'id' | 'kind' | 'label' | 'title' | 'command' | 'startedAt'> {
  const base = { id: call.toolUseId, startedAt: call.at };
  if (call.subagent) {
    return {
      ...base,
      kind: 'subagent',
      label: call.subagent,
      title: call.description ?? (call.summary || 'Subagent'),
    };
  }
  return {
    ...base,
    kind: 'shell',
    title: call.description ?? 'Background command',
    command: call.summary || undefined,
  };
}

function outcome(
  call: Call,
  result: Result | undefined,
  updates: Map<string, Update>,
  sessionState: SessionState,
): Pick<BackgroundTask, 'status' | 'tail' | 'endedAt'> {
  const update =
    updates.get(call.toolUseId) ?? (result?.taskId ? updates.get(result.taskId) : undefined);
  if (update) {
    return {
      status:
        update.status === 'completed' ? 'pass' : update.status === 'failed' ? 'fail' : 'ended',
      tail: update.summary || (update.status === 'killed' ? 'Stopped' : undefined),
      endedAt: update.at,
    };
  }
  if (result && !result.taskId) {
    // Ended with its result: a blocking subagent, or a call that failed to start. A background
    // shell whose result names no task can't be followed further.
    const tail = firstLine(result.text);
    if (result.isError) return { status: 'fail', tail, endedAt: result.at };
    if (call.subagent && !call.background) return { status: 'pass', tail, endedAt: result.at };
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

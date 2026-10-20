import { relative } from 'node:path';
import type { RunningTask, SessionReport } from '@joc/protocol';

/** The hook fields we read. See https://code.claude.com/docs/en/hooks for the full shapes. */
export interface HookInput {
  session_id: string;
  hook_event_name: string;
  cwd: string;
  transcript_path?: string;
  source?: string;
  prompt?: string;
  session_title?: string;
  model?: unknown;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  notification_type?: string;
  message?: string;
  last_assistant_message?: string;
  /** On Stop: Claude Code's in-flight background work. Empty when nothing is in flight. */
  background_tasks?: unknown[];
  /** On Stop: the session's scheduled wakeups (CronCreate, ScheduleWakeup, /loop). */
  session_crons?: unknown[];
  /** On a Sync from register.ts: whether its session can show a native notification. */
  can_notify?: boolean;
}

/** The part of a report decided by the hook event alone. */
export type EventFields = Pick<
  SessionReport,
  'state' | 'activity' | 'title' | 'name' | 'model' | 'background'
>;

/** The most background tasks a report carries; matches MAX_RUNNING_TASKS in @joc/protocol. */
const MAX_TASKS = 50;

/** A string field of `o`, cut to `max` characters; undefined when it isn't a non-empty string. */
function field(o: Record<string, unknown>, key: string, max: number): string | undefined {
  const v = o[key];
  if (typeof v !== 'string' || !v) return undefined;
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}

/** Leaves out the fields that aren't set, so the report stays small. */
function defined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/**
 * Claude Code's own list of what runs in the background, from a Stop's `background_tasks` and
 * `session_crons`, bounded to fit the report. Undefined when the hook carries neither.
 */
export function runningTasks(input: HookInput): RunningTask[] | undefined {
  const { background_tasks: tasks, session_crons: crons } = input;
  if (!Array.isArray(tasks) && !Array.isArray(crons)) return undefined;
  const list: RunningTask[] = [];
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (!t || typeof t !== 'object') continue;
    const o = t as Record<string, unknown>;
    const id = field(o, 'id', 200);
    if (!id) continue;
    list.push(
      defined({
        id,
        type: field(o, 'type', 50) ?? 'task',
        status: field(o, 'status', 50),
        description: field(o, 'description', 1000),
        command: field(o, 'command', 1000),
        agentType: field(o, 'agent_type', 100),
        server: field(o, 'server', 200),
        tool: field(o, 'tool', 200),
        name: field(o, 'name', 200),
      }),
    );
  }
  for (const c of Array.isArray(crons) ? crons : []) {
    if (!c || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    const id = field(o, 'id', 200);
    if (!id) continue;
    list.push(
      defined({
        id,
        type: 'cron',
        description: field(o, 'prompt', 1000),
        schedule: field(o, 'schedule', 100),
      }),
    );
  }
  return list.slice(0, MAX_TASKS);
}

/** First non-empty line, whitespace collapsed, cut to `max` characters. */
export function firstLine(text: string | undefined, max = 120): string | undefined {
  const line = text
    ?.split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .find(Boolean);
  if (!line) return undefined;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function modelName(model: unknown): string | undefined {
  if (typeof model === 'string') return model;
  if (model && typeof model === 'object') {
    const m = model as { display_name?: unknown; id?: unknown };
    if (typeof m.display_name === 'string') return m.display_name;
    if (typeof m.id === 'string') return m.id;
  }
  return undefined;
}

/** A readable tool name: "mcp__claude-in-chrome__navigate" → "claude-in-chrome · navigate". */
export function toolLabel(name: string | undefined): string {
  const mcp = name?.match(/^mcp__(.+?)__(.+)$/);
  return mcp ? `${mcp[1]} · ${mcp[2]}` : (name ?? 'Tool');
}

/** What a tool call touches, without the tool's name: "src/auth.ts", "pnpm test". */
export function toolTarget(input: HookInput): string {
  const args = input.tool_input ?? {};
  const str = (key: string) => (typeof args[key] === 'string' ? (args[key] as string) : undefined);
  const path = str('file_path') ?? str('notebook_path');
  if (input.tool_name === 'Bash') return firstLine(str('command')) ?? '';
  if (path) return relative(input.cwd, path) || path;
  return firstLine(str('pattern') ?? str('url') ?? str('query') ?? str('description'), 100) ?? '';
}

/** One line for what a tool call is doing: "Edit src/auth.ts", "pnpm test". */
export function describeTool(input: HookInput): string {
  const target = toolTarget(input);
  if (input.tool_name === 'Bash' && target) return target;
  return target ? `${toolLabel(input.tool_name)} ${target}` : toolLabel(input.tool_name);
}

/** Maps a hook event to the session's state, or undefined when the event changes nothing. */
export function eventFields(input: HookInput): EventFields | undefined {
  switch (input.hook_event_name) {
    case 'SessionStart':
      // After compaction Claude may still be mid-turn, so don't call it idle.
      if (input.source === 'compact') return undefined;
      return {
        state: 'idle',
        activity: input.source === 'resume' ? 'Resumed' : 'Waiting for your first message',
        name: input.session_title,
        model: modelName(input.model),
      };
    case 'UserPromptSubmit':
      return {
        state: 'working',
        activity: 'Thinking',
        title: firstLine(input.prompt, 80),
        name: input.session_title,
      };
    case 'PreToolUse':
      return { state: 'working', activity: describeTool(input) };
    case 'PostToolUse':
      return { state: 'working' };
    case 'PermissionRequest': {
      // A question asks for an answer, not permission: the session says what it asks.
      if (input.tool_name === 'AskUserQuestion') {
        const questions = input.tool_input?.questions;
        const first = Array.isArray(questions) ? (questions[0] as { question?: unknown }) : {};
        const asked = typeof first?.question === 'string' ? first.question : undefined;
        return { state: 'needs', activity: firstLine(asked) ?? 'Claude is asking' };
      }
      return { state: 'needs', activity: `Permission: ${describeTool(input)}` };
    }
    case 'Notification':
      // A permission prompt's notice follows its PermissionRequest, which said more: what the
      // call does, or what the question asks. It keeps that.
      if (input.notification_type === 'permission_prompt') return { state: 'needs' };
      return { state: 'needs', activity: firstLine(input.message) ?? 'Waiting for you' };
    case 'Stop': {
      // Claude Code's list is the truth for what runs. Older versions send none: then the count
      // is all there is, and the stored list stays as it was.
      const background = runningTasks(input);
      const running = background?.length ?? input.background_tasks?.length ?? 0;
      const list = background ? { background } : {};
      if (running) {
        return {
          state: 'background',
          activity: `${running} background ${running === 1 ? 'task' : 'tasks'} running`,
          ...list,
        };
      }
      return {
        state: 'idle',
        activity: firstLine(input.last_assistant_message) ?? 'Done',
        ...list,
      };
    }
    case 'SessionEnd':
      // Its background work ends with it.
      return { state: 'offline', activity: 'Session ended', background: [] };
    default:
      return undefined;
  }
}

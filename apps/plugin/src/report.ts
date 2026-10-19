import { relative } from 'node:path';
import type { SessionReport } from '@joc/protocol';

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
  background_tasks?: unknown[];
  /** On a Sync from register.ts: whether its session can show a native notification. */
  can_notify?: boolean;
}

/** The part of a report decided by the hook event alone. */
export type EventFields = Pick<SessionReport, 'state' | 'activity' | 'title' | 'name' | 'model'>;

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
    case 'PermissionRequest':
      return { state: 'needs', activity: `Permission: ${describeTool(input)}` };
    case 'Notification':
      return { state: 'needs', activity: firstLine(input.message) ?? 'Waiting for you' };
    case 'Stop': {
      const running = input.background_tasks?.length ?? 0;
      if (running) {
        return {
          state: 'background',
          activity: `${running} background ${running === 1 ? 'task' : 'tasks'} running`,
        };
      }
      return { state: 'idle', activity: firstLine(input.last_assistant_message) ?? 'Done' };
    }
    case 'SessionEnd':
      return { state: 'offline', activity: 'Session ended' };
    default:
      return undefined;
  }
}

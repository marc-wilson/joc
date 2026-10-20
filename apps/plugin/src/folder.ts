// Which folder a session works in, for its repo, branch, worktree and diff. A hook's `cwd` is the
// folder of whatever fired it: a subagent working in a worktree of its own fires hooks from
// there, with `agent_id` set. So only the session's own main loop moves its folder (a `cd`, or
// EnterWorktree); each such event is remembered, and a subagent's event or a sync (whose folder
// register.ts reads, and may not follow the session into a worktree) reports the remembered one.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookInput } from './report.ts';

/** The session's folder as of a main-loop hook that fired at `at`. */
export interface Remembered {
  cwd: string;
  at: number;
}

/** True when the hook fired inside a subagent (or teammate) rather than the session itself. */
export function fromSubagent(input: Pick<HookInput, 'agent_id'>): boolean {
  return typeof input.agent_id === 'string' && input.agent_id !== '';
}

/**
 * The session's own folder for this event. A main-loop event's `cwd` is the session's, so it
 * wins; anything else takes the one remembered, then the folder Claude Code last wrote in the
 * session's own transcript, and only then the event's.
 */
export function sessionFolder(
  input: Pick<HookInput, 'hook_event_name' | 'cwd' | 'agent_id'>,
  remembered: Remembered | undefined,
  transcriptCwd?: () => string | undefined,
): string {
  if (!fromSubagent(input) && input.hook_event_name !== 'Sync') return input.cwd;
  return remembered?.cwd ?? transcriptCwd?.() ?? input.cwd;
}

/** Whether this event moves the remembered folder: only the session's own main loop does. */
export function movesFolder(input: Pick<HookInput, 'hook_event_name' | 'agent_id'>): boolean {
  return !fromSubagent(input) && input.hook_event_name !== 'Sync';
}

/**
 * The folder of the last of the session's own entries in these transcript lines: a subagent's
 * live in their own transcripts, and a sidechain entry here is one too.
 */
export function lastOwnCwd(lines: string[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: unknown;
    try {
      entry = JSON.parse(lines[i] as string);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const { cwd, isSidechain, agentId } = entry as Record<string, unknown>;
    if (isSidechain === true || agentId) continue;
    if (typeof cwd === 'string' && cwd) return cwd;
  }
  return undefined;
}

// Kept beside the other per-session records (settle.ts).
function folderFile(sessionId: string): string {
  const dir = join(process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), 'joc-plugin'), 'folders');
  mkdirSync(dir, { recursive: true });
  return join(dir, `${sessionId.replace(/[^\w-]/g, '_')}.json`);
}

/** The folder last remembered for the session; undefined when there is none or it's unreadable. */
export function rememberedFolder(sessionId: string): Remembered | undefined {
  try {
    const r = JSON.parse(readFileSync(folderFile(sessionId), 'utf8')) as Remembered;
    return typeof r?.cwd === 'string' && r.cwd && typeof r.at === 'number' ? r : undefined;
  } catch {
    return undefined;
  }
}

/** Remembers the session's folder. Hooks run in parallel: an older one never wins. Never throws. */
export function rememberFolder(sessionId: string, cwd: string, at: number): void {
  try {
    const before = rememberedFolder(sessionId);
    if (before && before.at > at) return;
    writeFileSync(folderFile(sessionId), JSON.stringify({ cwd, at }));
  } catch {}
}

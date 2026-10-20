// A session's state changes only when one of its hooks fires, so background work that ends
// between turns would leave it shown as running until the next turn. On a sync between turns
// (register.ts says no turn runs), this re-derives the state from what the plugin last reported
// and the transcript: once every background task that report listed has ended, it's idle.
// Anything uncertain leaves the state as it is.
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunningTask, SessionState } from '@joc/protocol';
import { type EventFields, firstLine } from './report.ts';
import { taskNotification } from './transcript.ts';

/** What the plugin last told the server about a session's state. */
export interface Reported {
  state: SessionState;
  /** The report's `at`: an older report never overwrites a newer one's record. */
  at: number;
  /** The background tasks it listed; absent when it listed none (a Claude Code without the list). */
  tasks?: Pick<RunningTask, 'id' | 'type' | 'status'>[];
}

// Kept beside the read positions (transcript.ts). A sync passes an empty CLAUDE_PLUGIN_DATA when
// it can't tell the plugin's data folder.
function reportedFile(sessionId: string): string {
  const dir = join(process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), 'joc-plugin'), 'reported');
  mkdirSync(dir, { recursive: true });
  return join(dir, `${sessionId.replace(/[^\w-]/g, '_')}.json`);
}

/** The last state the plugin reported for this session; undefined when it can't tell. */
export function lastReported(sessionId: string): Reported | undefined {
  try {
    const r = JSON.parse(readFileSync(reportedFile(sessionId), 'utf8')) as Reported;
    return typeof r?.state === 'string' && typeof r.at === 'number' ? r : undefined;
  } catch {
    return undefined;
  }
}

/** Records a report the server took. Hooks run in parallel: an older one never wins. */
export function rememberReported(sessionId: string, fields: EventFields, at: number): void {
  if (!fields.state) return;
  const before = lastReported(sessionId);
  if (before && before.at > at) return;
  const tasks = fields.background?.map(({ id, type, status }) =>
    status ? { id, type, status } : { id, type },
  );
  const record: Reported = { state: fields.state, at, ...(tasks ? { tasks } : {}) };
  writeFileSync(reportedFile(sessionId), JSON.stringify(record));
}

/** How much of the transcript's end is read for ended tasks: where a recent end would be. */
const TAIL_BYTES = 8 * 1024 * 1024;

/** The transcript's last whole lines, up to TAIL_BYTES of them. */
export function readTail(path: string, max = TAIL_BYTES): string[] {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    // One byte before the cut too, to tell whether it falls at a line's start.
    const start = Math.max(0, size - max - 1);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    // A cut first line, and a last one still being written, are left out.
    return lines.slice(start > 0 ? 1 : 0, -1).filter(Boolean);
  } finally {
    closeSync(fd);
  }
}

type Entry = {
  type?: string;
  isSidechain?: boolean;
  message?: { content?: unknown };
  attachment?: { type?: string; prompt?: unknown };
  toolUseResult?: unknown;
};

const ENDED: readonly string[] = ['completed', 'failed', 'killed'];

/** A tool result that says it stopped a background task (TaskStop, or KillShell before it). */
function stoppedTask(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const r = result as Record<string, unknown>;
  const message = typeof r.message === 'string' ? r.message : '';
  if (!/^Successfully (stopped task|killed shell)/.test(message)) return undefined;
  const id = r.task_id ?? r.shell_id;
  return typeof id === 'string' && id ? id : undefined;
}

export interface TranscriptState {
  /** Background tasks the transcript says ended: a final task notification or a stop. */
  ended: Set<string>;
  /** First line of the main conversation's last reply from Claude. */
  lastReply?: string;
}

/** What the transcript's lines say about how the session's background work went. */
export function readTranscriptState(lines: string[]): TranscriptState {
  const ended = new Set<string>();
  let lastReply: string | undefined;
  for (const line of lines) {
    let entry: Entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object' || entry.isSidechain) continue;
    const content = entry.message?.content;
    const notice =
      entry.type === 'attachment' && entry.attachment?.type === 'queued_command'
        ? entry.attachment.prompt
        : entry.type === 'user'
          ? content
          : undefined;
    if (typeof notice === 'string' && notice.includes('<task-notification>')) {
      const update = taskNotification(notice);
      if (update) ended.add(update.taskId);
      continue;
    }
    if (entry.type === 'user') {
      const stopped = stoppedTask(entry.toolUseResult);
      if (stopped) ended.add(stopped);
    }
    if (entry.type === 'assistant' && Array.isArray(content)) {
      const text = content
        .filter(
          (b) => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string',
        )
        .map((b) => b.text as string)
        .join('\n');
      const reply = firstLine(text);
      if (reply) lastReply = reply;
    }
  }
  return { ended, lastReply };
}

/**
 * The state a sync reports, or undefined to leave the server's as it is. Only a session between
 * turns that was last reported `background` can change, and only to `idle`, once every task that
 * report listed has ended: by its own status, or by the transcript. A list that isn't known, or a
 * task the transcript can't vouch for (a scheduled wakeup), keeps it as it is.
 */
export function settledFields(
  reported: Reported | undefined,
  betweenTurns: boolean,
  transcript: TranscriptState | undefined,
): EventFields | undefined {
  if (!betweenTurns || reported?.state !== 'background' || !reported.tasks || !transcript) {
    return undefined;
  }
  const running = reported.tasks.filter(
    (t) => !(t.status && ENDED.includes(t.status)) && !transcript.ended.has(t.id),
  );
  if (running.length) return undefined;
  return { state: 'idle', activity: transcript.lastReply ?? 'Done', background: [] };
}

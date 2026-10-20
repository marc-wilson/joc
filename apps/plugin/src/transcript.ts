import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { ConversationItem, ImageRef } from '@joc/protocol';
import { imageType, MAX_IMAGES, takeImageLines } from './images.ts';
import { firstLine, toolLabel, toolTarget } from './report.ts';

// The transcript format isn't documented and may change. Everything here reads it defensively:
// an entry we don't recognize is skipped, never an error.

/** Never send more than this much of a transcript in one go (e.g. the first read of a long one). */
const MAX_READ_BYTES = 1024 * 1024;
/** A line can be far longer: pasted images ride inside it, base64. One cut at the start of the
 * read is still taken whole, up to this size. */
const MAX_LINE_BYTES = 64 * 1024 * 1024;

const cut = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

// Where each session's read position is kept between hook runs. A sync passes an empty
// CLAUDE_PLUGIN_DATA when it can't tell the plugin's data folder.
function offsetFile(sessionId: string): string {
  const dir = join(process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), 'joc-plugin'), 'offsets');
  mkdirSync(dir, { recursive: true });
  return join(dir, `${sessionId.replace(/[^\w-]/g, '_')}.offset`);
}

function readOffset(file: string): number {
  try {
    return Number(readFileSync(file, 'utf8')) || 0;
  } catch {
    return 0;
  }
}

export interface NewLines {
  lines: string[];
  /** Saves the read position. Call it only once the lines are safely sent, so a failed send
   * is retried on the next hook instead of lost. */
  commit: () => void;
}

/**
 * Complete transcript lines written since the last commit for this session. Hooks run in
 * parallel, so two calls can return the same lines; the server ignores items it already has.
 */
export function readNewLines(sessionId: string, transcriptPath: string): NewLines {
  const file = offsetFile(sessionId);
  const fd = openSync(transcriptPath, 'r');
  try {
    const size = fstatSync(fd).size;
    let start = readOffset(file);
    if (start > size) start = 0; // The transcript was replaced.
    let skipPartial = false;
    if (size - start > MAX_READ_BYTES) {
      const cut = size - MAX_READ_BYTES;
      const line = lineStart(fd, cut, Math.max(start, size - MAX_LINE_BYTES), start);
      skipPartial = line === undefined;
      start = line ?? cut;
    }
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    // Only whole lines: a line still being written is picked up next time.
    const end = buffer.lastIndexOf(0x0a) + 1;
    const lines = buffer.subarray(0, end).toString('utf8').split('\n').filter(Boolean);
    return {
      lines: skipPartial ? lines.slice(1) : lines,
      commit: () => writeFileSync(file, String(start + end)),
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * Where the line holding byte `at` starts, looking back no further than `floor`; undefined when
 * it starts before that. `start` is a known line start (the last read position).
 */
function lineStart(fd: number, at: number, floor: number, start: number): number | undefined {
  const chunk = Buffer.alloc(64 * 1024);
  for (let end = at; end > floor; ) {
    const from = Math.max(floor, end - chunk.length);
    readSync(fd, chunk, 0, end - from, from);
    const newline = chunk.subarray(0, end - from).lastIndexOf(0x0a);
    if (newline >= 0) return from + newline + 1;
    end = from;
  }
  return floor === start ? start : undefined;
}

/**
 * Where Claude Code keeps a session's transcript, for a sync, which isn't given the path:
 * `<config>/projects/<project>/<session id>.jsonl`. The project folder is usually the working
 * directory with every other character turned into `-`; any other project folder is searched.
 */
export function findTranscript(sessionId: string, cwd: string): string | undefined {
  if (!/^[\w-]+$/.test(sessionId)) return undefined;
  const projects = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
  const name = `${sessionId}.jsonl`;
  const likely = join(projects, cwd.replace(/[^a-zA-Z0-9]/g, '-'), name);
  if (existsSync(likely)) return likely;
  try {
    for (const dir of readdirSync(projects)) {
      const path = join(projects, dir, name);
      if (existsSync(path)) return path;
    }
  } catch {}
  return undefined;
}

/** New lines of one background subagent's own transcript. */
export interface SubagentLines extends NewLines {
  /** The `toolUseId` of the call that started it. */
  task: string;
}

/**
 * New lines from the transcripts of the session's subagents, which Claude Code keeps next to the
 * session's: `<session id>/subagents/agent-<id>.jsonl`, each with an `agent-<id>.meta.json` that
 * names the call that started it. Stops after about `budget` bytes; the rest comes next time.
 */
export function readSubagents(
  sessionId: string,
  transcriptPath: string,
  budget = MAX_READ_BYTES,
): SubagentLines[] {
  const dir = join(dirname(transcriptPath), sessionId, 'subagents');
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => /^agent-[\w-]+\.jsonl$/.test(n));
  } catch {
    return [];
  }
  const found: SubagentLines[] = [];
  let read = 0;
  for (const name of names) {
    if (read >= budget) break;
    const agent = basename(name, '.jsonl');
    try {
      const { lines, commit } = readNewLines(`${sessionId}.${agent}`, join(dir, name));
      if (!lines.length) continue;
      const meta: unknown = JSON.parse(readFileSync(join(dir, `${agent}.meta.json`), 'utf8'));
      const task = isBlock(meta) ? str(meta.toolUseId) : undefined;
      if (!task) continue; // Can't tell which task it belongs to: leave it.
      read += lines.reduce((n, l) => n + l.length, 0);
      found.push({ task: cut(task, 200), lines, commit });
    } catch {}
  }
  return found;
}

interface Entry {
  type?: string;
  subtype?: string;
  uuid?: string;
  parentUuid?: string;
  timestamp?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  aiTitle?: string;
  message?: { content?: unknown };
  /** Claude Code's structured record of a tool's result, next to the tool_result block. */
  toolUseResult?: unknown;
  attachment?: { type?: string; prompt?: unknown };
  /** A `system` entry's text, e.g. a `local_command` one's command or output. */
  content?: unknown;
}

type Block = Record<string, unknown> & { type?: string };

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

const isBlock = (v: unknown): v is Block => !!v && typeof v === 'object' && !Array.isArray(v);

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: Block) => (b.type === 'text' ? str(b.text) : b.type === 'image' ? '[image]' : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * A slash command as the transcript records it, in a user entry or a `local_command` system one:
 * `<command-name>/review</command-name>`, `<command-message>…` and `<command-args>auth…`, in
 * any order.
 */
function slashCommand(text: string): { name: string; args: string } | undefined {
  const name = text.match(/<command-name>\/?([^<]+)<\/command-name>/)?.[1]?.trim();
  if (!name) return undefined;
  return {
    name: cut(name, 100),
    args: cut(text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim() ?? '', 20_000),
  };
}

// Terminal colour codes, in case a command's output keeps them.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');

/** What a built-in command printed: `<local-command-stdout>` (or `-stderr`) around the text. */
function commandOutput(text: string): { text: string; isError: boolean } | undefined {
  const out = text.match(/<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>/);
  const printed = out?.[2]?.replace(ANSI, '').trim();
  return out && printed ? { text: cut(printed, 5_000), isError: out[1] === 'stderr' } : undefined;
}

type TaskUpdate = Extract<ConversationItem, { kind: 'task_update' }>;

const STATUSES: readonly string[] = ['completed', 'failed', 'killed'];

/** Most of a background shell's output kept, from its end. */
const MAX_OUTPUT = 20_000;

/**
 * The end of what a background shell printed, from the file Claude Code wrote it to. Only a
 * plain file named for the task: a subagent's output file is a link to its transcript, which
 * is sent as steps instead.
 */
function shellOutput(path: string, taskId: string): string | undefined {
  if (basename(path) !== `${taskId}.output`) return undefined;
  try {
    if (!lstatSync(path).isFile()) return undefined;
    const fd = openSync(path, 'r');
    try {
      const size = fstatSync(fd).size;
      const length = Math.min(size, MAX_OUTPUT * 4);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      const text = buffer.toString('utf8').replace(ANSI, '').trimEnd();
      return text.length > MAX_OUTPUT ? `…${text.slice(-(MAX_OUTPUT - 1))}` : text || undefined;
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/**
 * Claude Code tells Claude a background task ended with a `<task-notification>` message:
 * `<task-id>`, `<tool-use-id>` (not always), `<status>` and `<summary>`; a subagent's carries
 * its final report in `<result>`, a shell's names the `<output-file>` it printed to.
 * Notifications without a final status (progress events) are skipped.
 */
export function taskNotification(
  text: string,
):
  | Pick<TaskUpdate, 'taskId' | 'toolUseId' | 'status' | 'summary' | 'result' | 'output'>
  | undefined {
  const block = text.match(/<task-notification>([\s\S]*?)<\/task-notification>/)?.[1];
  if (!block) return undefined;
  const tag = (name: string) =>
    block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim() || undefined;
  const taskId = tag('task-id');
  const status = tag('status');
  if (!taskId || !status || !STATUSES.includes(status)) return undefined;
  const result = tag('result');
  const outputFile = tag('output-file');
  const output = !result && outputFile ? shellOutput(outputFile, taskId) : undefined;
  return {
    taskId: cut(taskId, 200),
    toolUseId: tag('tool-use-id')?.slice(0, 200),
    status: status as TaskUpdate['status'],
    summary: firstLine(tag('summary'), 500) ?? '',
    ...(result ? { result: cut(result, 50_000) } : {}),
    ...(output ? { output } : {}),
  };
}

/** The background task a tool result left running: a shell's task id or an async agent's id. */
function startedTask(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const r = result as Record<string, unknown>;
  const id =
    str(r.backgroundTaskId) ?? (r.status === 'async_launched' ? str(r.agentId) : undefined);
  return id ? cut(id, 200) : undefined;
}

/** Whether a tool result is a subagent's, by Claude Code's record of it. */
const startedAgent = (result: unknown) => isBlock(result) && typeof result.agentId === 'string';

/** An image pasted into a prompt, still to be uploaded and added to its item's `images`. */
export interface TranscriptImage {
  itemId: string;
  /** The type Claude Code recorded; the server checks it against the bytes. */
  type: ImageRef['type'];
  /** The bytes, base64. */
  data: string;
}

/** The base64 images among a user message's blocks, as many as a message may carry. */
function pastedImages(content: Block[]): Omit<TranscriptImage, 'itemId'>[] {
  return content
    .flatMap((block) => {
      const source = block.type === 'image' ? block.source : undefined;
      if (!isBlock(source)) return [];
      const { type: kind, media_type, data } = source;
      const type = imageType(media_type);
      return kind === 'base64' && type && typeof data === 'string' ? [{ type, data }] : [];
    })
    .slice(0, MAX_IMAGES);
}

type UserItem = Extract<ConversationItem, { kind: 'user' }>;

/** A user item, with the images JOC named in its text shown as images instead. */
function userItem(id: string, at: string, text: string): UserItem {
  const taken = takeImageLines(text);
  return {
    id,
    at,
    kind: 'user',
    text: cut(taken.text, 20_000),
    ...(taken.images.length ? { images: taken.images } : {}),
  };
}

export interface Parsed {
  items: ConversationItem[];
  /** Pasted images, for the items above that showed them. */
  images: TranscriptImage[];
  /** The latest title Claude Code generated, if one was in these lines. */
  aiTitle?: string;
}

/**
 * Conversation items from transcript lines. With `task`, the lines are that subagent's own
 * transcript: its entries are all sidechain ones, its first message is the prompt (already sent
 * with the call that started it) and every item is marked with the task.
 */
export function parseLines(lines: string[], cwd: string, task?: string): Parsed {
  const parsed = parseEntries(lines, cwd, task !== undefined);
  if (task) for (const item of parsed.items) item.task = task;
  return parsed;
}

function parseEntries(lines: string[], cwd: string, sidechain: boolean): Parsed {
  const items: ConversationItem[] = [];
  /** Subagent calls seen so far, whose results are their final reports. */
  const subagentCalls = new Set<string>();
  const images: TranscriptImage[] = [];
  let aiTitle: string | undefined;
  for (const line of lines) {
    let entry: Entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === 'ai-title' && entry.aiTitle) aiTitle = entry.aiTitle;
    if (entry.isMeta || !entry.uuid || !entry.timestamp) continue;
    if (!!entry.isSidechain !== sidechain) continue;
    const at = new Date(entry.timestamp).toISOString();
    const content = entry.message?.content;

    // A notification that arrived mid-turn is queued as an attachment instead of a user message.
    const notice =
      entry.type === 'attachment' && entry.attachment?.type === 'queued_command'
        ? str(entry.attachment.prompt)
        : entry.type === 'user' && typeof content === 'string'
          ? content
          : undefined;
    const update = notice?.trimStart().startsWith('<task-notification>')
      ? taskNotification(notice)
      : undefined;
    if (update) {
      items.push({ id: entry.uuid, at, kind: 'task_update', ...update });
      continue;
    }
    // A command and what it printed: user entries, or `local_command` system ones.
    const recorded =
      entry.type === 'user' && typeof content === 'string'
        ? content
        : entry.type === 'system' && entry.subtype === 'local_command'
          ? str(entry.content)
          : undefined;
    const command = recorded ? slashCommand(recorded) : undefined;
    if (command) {
      items.push({ id: entry.uuid, at, kind: 'command', ...command });
      continue;
    }
    const output = recorded ? commandOutput(recorded) : undefined;
    if (output) {
      const commandId = entry.parentUuid?.slice(0, 200);
      items.push({ id: entry.uuid, at, kind: 'command_output', commandId, ...output });
      continue;
    }
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;

    if (entry.type === 'user' && typeof content === 'string') {
      if (sidechain && !entry.parentUuid) continue; // The subagent's prompt.
      if (!content.startsWith('<')) {
        // Other tagged strings are Claude Code's own bookkeeping (command output, caveats).
        items.push(userItem(entry.uuid, at, content));
      }
      continue;
    }
    if (!Array.isArray(content)) continue;
    // The structured result belongs to the entry, so only trust it for a single result.
    const results = content.filter((b: Block) => b.type === 'tool_result').length;
    const firstItem = items.length;

    content.forEach((block: Block, i) => {
      const id = `${entry.uuid}:${i}`;
      if (entry.type === 'assistant' && block.type === 'text' && str(block.text)?.trim()) {
        items.push({ id, at, kind: 'claude', text: cut(str(block.text) ?? '', 50_000) });
      } else if (entry.type === 'assistant' && block.type === 'tool_use') {
        const name = str(block.name) ?? 'Tool';
        const input = (block.input && typeof block.input === 'object' ? block.input : {}) as Record<
          string,
          unknown
        >;
        const subagent = name === 'Agent' || name === 'Task';
        const background = input.run_in_background === true || input.run_in_background === 'true';
        const toolUseId = str(block.id) ?? id;
        if (subagent) subagentCalls.add(toolUseId);
        const command = str(input.command);
        items.push({
          id,
          at,
          kind: 'tool_call',
          toolUseId,
          name: toolLabel(name),
          summary: cut(
            toolTarget({
              session_id: '',
              hook_event_name: '',
              cwd,
              tool_name: name,
              tool_input: input,
            }),
            500,
          ),
          description: firstLine(str(input.description), 200),
          background: background && (subagent || name === 'Bash') ? true : undefined,
          subagent: subagent ? cut(str(input.subagent_type) ?? 'general-purpose', 100) : undefined,
          prompt: subagent && str(input.prompt) ? cut(str(input.prompt) ?? '', 20_000) : undefined,
          command:
            background && name === 'Bash' && command?.trim().includes('\n')
              ? cut(command, 5_000)
              : undefined,
        });
      } else if (entry.type === 'user' && block.type === 'tool_result') {
        const toolUseId = str(block.tool_use_id) ?? '';
        // A subagent's result is its final report: keep more of it.
        const report = subagentCalls.has(toolUseId) || startedAgent(entry.toolUseResult);
        items.push({
          id,
          at,
          kind: 'tool_result',
          toolUseId,
          isError: block.is_error === true,
          text: cut(resultText(block.content), report ? 50_000 : 5_000),
          taskId: results === 1 ? startedTask(entry.toolUseResult) : undefined,
        });
      } else if (entry.type === 'user' && block.type === 'text' && str(block.text)?.trim()) {
        const text = str(block.text) ?? '';
        if (!text.startsWith('<')) items.push(userItem(id, at, text));
      }
    });

    // Pasted images go with the message's first text, or make an item of their own.
    const pasted = entry.type === 'user' ? pastedImages(content) : [];
    if (pasted.length) {
      let host = items.slice(firstItem).find((i) => i.kind === 'user');
      if (!host) {
        host = { id: `${entry.uuid}:images`, at, kind: 'user', text: '' };
        items.push(host);
      }
      const itemId = host.id;
      images.push(...pasted.map((image) => ({ ...image, itemId })));
    }
  }
  return { items, images, aiTitle: firstLine(aiTitle, 200) };
}

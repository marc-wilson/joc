import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
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

interface Entry {
  type?: string;
  uuid?: string;
  timestamp?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  aiTitle?: string;
  message?: { content?: unknown };
  /** Claude Code's structured record of a tool's result, next to the tool_result block. */
  toolUseResult?: unknown;
  attachment?: { type?: string; prompt?: unknown };
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

/** `<command-name>/review</command-name>…<command-args>x</command-args>` → review, x */
function slashCommand(text: string): { command: string; args: string } | undefined {
  const name = text.match(/<command-name>\/?([^<]+)<\/command-name>/)?.[1];
  if (!name) return undefined;
  return {
    command: name.trim(),
    args: text.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim() ?? '',
  };
}

type TaskUpdate = Extract<ConversationItem, { kind: 'task_update' }>;

const STATUSES: readonly string[] = ['completed', 'failed', 'killed'];

/**
 * Claude Code tells Claude a background task ended with a `<task-notification>` message:
 * `<task-id>`, `<tool-use-id>` (not always), `<status>` and `<summary>`. Notifications without
 * a final status (progress events) are skipped.
 */
export function taskNotification(
  text: string,
): Pick<TaskUpdate, 'taskId' | 'toolUseId' | 'status' | 'summary'> | undefined {
  const block = text.match(/<task-notification>([\s\S]*?)<\/task-notification>/)?.[1];
  if (!block) return undefined;
  const tag = (name: string) =>
    block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim() || undefined;
  const taskId = tag('task-id');
  const status = tag('status');
  if (!taskId || !status || !STATUSES.includes(status)) return undefined;
  return {
    taskId: cut(taskId, 200),
    toolUseId: tag('tool-use-id')?.slice(0, 200),
    status: status as TaskUpdate['status'],
    summary: firstLine(tag('summary'), 500) ?? '',
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

export function parseLines(lines: string[], cwd: string): Parsed {
  const items: ConversationItem[] = [];
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
    if (entry.isMeta || entry.isSidechain || !entry.uuid || !entry.timestamp) continue;
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
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;

    if (entry.type === 'user' && typeof content === 'string') {
      const slash = slashCommand(content);
      if (slash) {
        items.push({
          id: entry.uuid,
          at,
          kind: 'user',
          text: cut(slash.args, 20_000),
          command: slash.command,
        });
      } else if (!content.startsWith('<')) {
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
        items.push({
          id,
          at,
          kind: 'tool_call',
          toolUseId: str(block.id) ?? id,
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
        });
      } else if (entry.type === 'user' && block.type === 'tool_result') {
        items.push({
          id,
          at,
          kind: 'tool_result',
          toolUseId: str(block.tool_use_id) ?? '',
          isError: block.is_error === true,
          text: cut(resultText(block.content), 5_000),
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

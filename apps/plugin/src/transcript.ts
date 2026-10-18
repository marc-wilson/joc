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
import type { ConversationItem } from '@joc/protocol';
import { firstLine, toolLabel, toolTarget } from './report.ts';

// The transcript format isn't documented and may change. Everything here reads it defensively:
// an entry we don't recognize is skipped, never an error.

/** Never send more than this much of a transcript in one go (e.g. the first read of a long one). */
const MAX_READ_BYTES = 1024 * 1024;

const cut = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

// Where each session's read position is kept between hook runs.
function offsetFile(sessionId: string): string {
  const dir = join(process.env.CLAUDE_PLUGIN_DATA ?? join(tmpdir(), 'joc-plugin'), 'offsets');
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
    const skipPartial = size - start > MAX_READ_BYTES;
    if (skipPartial) start = size - MAX_READ_BYTES;
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

interface Entry {
  type?: string;
  uuid?: string;
  timestamp?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  aiTitle?: string;
  message?: { content?: unknown };
}

type Block = Record<string, unknown> & { type?: string };

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

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

export interface Parsed {
  items: ConversationItem[];
  /** The latest title Claude Code generated, if one was in these lines. */
  aiTitle?: string;
}

export function parseLines(lines: string[], cwd: string): Parsed {
  const items: ConversationItem[] = [];
  let aiTitle: string | undefined;
  for (const line of lines) {
    let entry: Entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === 'ai-title' && entry.aiTitle) aiTitle = entry.aiTitle;
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    if (entry.isMeta || entry.isSidechain || !entry.uuid || !entry.timestamp) continue;
    const at = new Date(entry.timestamp).toISOString();
    const content = entry.message?.content;

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
        items.push({ id: entry.uuid, at, kind: 'user', text: cut(content, 20_000) });
      }
      continue;
    }
    if (!Array.isArray(content)) continue;

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
        });
      } else if (entry.type === 'user' && block.type === 'tool_result') {
        items.push({
          id,
          at,
          kind: 'tool_result',
          toolUseId: str(block.tool_use_id) ?? '',
          isError: block.is_error === true,
          text: cut(resultText(block.content), 5_000),
        });
      } else if (entry.type === 'user' && block.type === 'text' && str(block.text)?.trim()) {
        const text = str(block.text) ?? '';
        if (!text.startsWith('<')) items.push({ id, at, kind: 'user', text: cut(text, 20_000) });
      }
    });
  }
  return { items, aiTitle: firstLine(aiTitle, 200) };
}

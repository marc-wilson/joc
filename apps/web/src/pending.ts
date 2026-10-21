import type { ConversationItem, ImageRef, PromptStatus, SessionState } from '@joc/protocol';
import { commandLine } from './commands.ts';

// A prompt sent from the dashboard shows at the bottom of the conversation until the session's
// own transcript has it, saying where it is on the way (issue #77):
//
//   sending ─▶ queued ─▶ (the transcript has it: a normal message, in the same place)
//      │          │
//      └──────────┴──▶ failed (Retry)
//
// `sending` covers the upload, the server, and the plugin taking it; until the plugin does, it
// can be cancelled or edited. `queued` means Claude Code has it: it runs when the turn ends, and
// JOC can't take it back (Claude Code has no way for a plugin to withdraw a queued prompt).

/** A prompt sent from the dashboard that the session's transcript doesn't have yet. */
export interface PendingPrompt {
  /** The browser's own id, kept from the first send through every retry. */
  id: string;
  sessionId: string;
  text: string;
  /** Its images, once uploaded. */
  images: ImageRef[];
  /** The images as pasted, until they're uploaded, so a retry can upload them again. */
  files?: File[];
  /** The server's id for it, once it has it. */
  serverId?: string;
  /** Why it never reached the server, when it didn't. */
  failed?: string;
  /** The conversation's last item when it was sent: its transcript copy comes after that. */
  after?: string;
}

export type PendingPhase = 'sending' | 'queued' | 'failed';

/** How one pending prompt shows. */
export interface PendingView {
  prompt: PendingPrompt;
  phase: PendingPhase;
  /** The line under the bubble. */
  line: string;
  /** Still in JOC: it can be cancelled or edited. */
  changeable: boolean;
  /** Its place among the session's queued prompts, from 1, when more than one is queued. */
  position?: number;
}

const ids = (images: ImageRef[] | undefined) => (images ?? []).map((i) => i.id).join(',');

const squash = (text: string) => text.trim().replace(/\s+/g, ' ');

/** Whether the item is the prompt's own copy: the same text and images, or the command it ran. */
function isCopy(item: ConversationItem, prompt: PendingPrompt): boolean {
  if (item.kind === 'command') {
    return !prompt.images.length && squash(commandLine(item)) === squash(prompt.text);
  }
  return (
    item.kind === 'user' &&
    item.text.trim() === prompt.text &&
    ids(item.images) === ids(prompt.images)
  );
}

/**
 * The transcript's copy of each pending prompt it has: pending id → item id. Each takes the
 * first copy after the item it was sent after that no earlier prompt took, so sending the same
 * text twice waits for two copies, and an older message with that text is never one.
 */
export function arrived(items: ConversationItem[], pending: PendingPrompt[]): Map<string, string> {
  const index = new Map(items.map((item, i) => [item.id, i]));
  const taken = new Set<string>();
  const found = new Map<string, string>();
  for (const prompt of pending) {
    if (prompt.failed) continue;
    const from = prompt.after === undefined ? 0 : (index.get(prompt.after) ?? -1) + 1;
    const copy = items.slice(from).find((i) => !taken.has(i.id) && isCopy(i, prompt));
    if (!copy) continue;
    taken.add(copy.id);
    found.set(prompt.id, copy.id);
  }
  return found;
}

/** "1st", "2nd", "3rd", "11th". */
export function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}

/** Whether a turn is under way, so a prompt Claude Code has waits for it to end. */
const busy = (state: SessionState) =>
  state === 'working' || state === 'background' || state === 'needs';

/**
 * How each of the session's pending prompts shows, in the order they were sent, from where the
 * server says each one stands (`statuses`, by server id) and the session's state.
 */
export function pendingViews(
  pending: PendingPrompt[],
  statuses: PromptStatus[] | undefined,
  state: SessionState,
): PendingView[] {
  const byId = new Map((statuses ?? []).map((s) => [s.id, s]));
  const phased = pending.map((prompt) => {
    const status = prompt.serverId ? byId.get(prompt.serverId) : undefined;
    if (prompt.failed) return { prompt, phase: 'failed' as const, reason: prompt.failed };
    if (status?.phase === 'failed') {
      return {
        prompt,
        phase: 'failed' as const,
        reason: status.reason ?? "Claude Code didn't take it",
      };
    }
    if (status?.phase === 'queued') return { prompt, phase: 'queued' as const };
    // Not on the server yet, or the server hasn't said: on its way. Only the server's own word
    // that it's still waiting lets it be changed.
    const waiting = status?.phase === 'waiting';
    if (waiting && state === 'offline') {
      return { prompt, phase: 'failed' as const, reason: 'the session is offline', held: true };
    }
    return { prompt, phase: 'sending' as const, changeable: waiting };
  });
  const queued = phased.filter((p) => p.phase === 'queued');
  return phased.map((p): PendingView => {
    if (p.phase === 'failed') {
      // Held in JOC for an offline session: it goes once the session is back, unless changed.
      const held = 'held' in p && !!p.held;
      return {
        prompt: p.prompt,
        phase: 'failed',
        line: `Not delivered: ${p.reason}${held ? ". It's sent when the session is back" : ''}`,
        changeable: held,
      };
    }
    if (p.phase === 'sending') {
      return { prompt: p.prompt, phase: 'sending', line: 'Sending…', changeable: !!p.changeable };
    }
    const position = queued.length > 1 ? queued.indexOf(p) + 1 : undefined;
    const line = busy(state)
      ? [
          'Queued',
          position ? `${ordinal(position)} in queue` : '',
          'Claude reads it when this turn ends',
        ]
          .filter(Boolean)
          .join(' · ')
      : 'Sent to Claude Code';
    return { prompt: p.prompt, phase: 'queued', line, changeable: false, position };
  });
}

const messages = (n: number) => `${n} ${n === 1 ? 'message' : 'messages'}`;

/** The line above the composer while anything waits, or undefined when nothing does. */
export function queueLine(views: PendingView[], state: SessionState): string | undefined {
  const waiting = views.filter((v) => v.phase !== 'failed' || v.changeable);
  if (!waiting.length) return undefined;
  if (state === 'offline')
    return `${messages(waiting.length)} waiting for the session to come back`;
  if (!busy(state)) return `Sending ${messages(waiting.length)}`;
  const line = `${messages(waiting.length)} queued for when Claude finishes`;
  // Said once here rather than on every bubble: what Claude Code has, JOC can't change.
  return waiting.every((v) => v.phase === 'queued')
    ? `${line} · In Claude Code's queue, can't be changed from JOC`
    : line;
}

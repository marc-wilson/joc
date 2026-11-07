import { type ConversationItem, type SessionState, teammateMessages } from '@joc/protocol';

/** What a batch of new conversation items says about the session's turn. */
export interface TurnNews {
  /** The first line of what Claude last said in the batch. */
  words?: string;
  /** You sent something and Claude's answer is still to come: anything unread is now read. */
  sent: boolean;
  /** You sent something and Claude's answer came after a report ended the turn. */
  answered: boolean;
}

/** What you sent: a teammate's message relayed by Claude Code isn't yours. */
const fromYou = (item: ConversationItem) =>
  item.kind === 'command' || (item.kind === 'user' && !teammateMessages(item.text));

const SETTLED: readonly SessionState[] = ['idle', 'background', 'offline'];

/**
 * Reads new items of a session in `state`. A hook reports a turn's end before it sends the
 * turn's last items, so a short turn's prompt can land after the report it led to.
 */
export function turnNews(items: ConversationItem[], state: SessionState): TurnNews {
  const own = items.filter((i) => !i.task);
  const prompt = own.findLastIndex(fromYou);
  const said = own.findLast((i) => i.kind === 'claude')?.text;
  const words = said
    ?.split('\n')
    .find((l) => l.trim())
    ?.trim()
    .slice(0, 500);
  if (prompt < 0) return { words, sent: false, answered: false };
  const replied = own.slice(prompt + 1).some((i) => i.kind === 'claude');
  const answered = replied && SETTLED.includes(state);
  return { words, sent: !answered, answered };
}

import type { ConversationItem } from '@joc/protocol';

/** What counts as a new message below: words from you or Claude, and commands. Tool calls,
 * their results and task updates are Claude's working, not messages to catch up on. */
const counts = (item: ConversationItem) =>
  item.kind === 'user' || item.kind === 'claude' || item.kind === 'command';

/** The items on screen when you scrolled up, by id: the line new messages are counted from. */
export const seenIds = (items: readonly ConversationItem[]): ReadonlySet<string> =>
  new Set(items.map((i) => i.id));

/**
 * How many messages arrived since you scrolled up: those not in `seen`. Ones that took a pending
 * message's place (`settled`) were already on screen as that message, so they don't count.
 */
export function unseenCount(
  items: readonly ConversationItem[],
  seen: ReadonlySet<string> | undefined,
  settled?: ReadonlySet<string>,
): number {
  if (!seen) return 0;
  return items.filter((i) => counts(i) && !seen.has(i.id) && !settled?.has(i.id)).length;
}

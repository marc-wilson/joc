/** What the jump control says: how many messages arrived below, or just where it goes. */
export function jumpLabel(count: number): string {
  if (count <= 0) return 'Jump to latest';
  return count === 1 ? '1 new message' : `${count} new messages`;
}

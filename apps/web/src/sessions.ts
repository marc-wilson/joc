import type { Session } from '@joc/protocol';

export interface SessionGroup {
  /** Stable key, also what a collapsed group is remembered by. */
  id: string;
  label: string;
  sessions: Session[];
}

export const PINNED_GROUP = 'pinned';

/**
 * The session list's groups: the sessions you pinned first, in the order you pinned them, then
 * each repo in first-seen order, so groups never reorder as sessions update. A pinned session
 * shows only in Pinned.
 */
export function groupSessions(list: Session[], pinned: string[]): SessionGroup[] {
  const byId = new Map(list.map((s) => [s.id, s]));
  const top = pinned.flatMap((id) => byId.get(id) ?? []);
  const repos = new Map<string, Session[]>();
  for (const s of list) {
    if (pinned.includes(s.id)) continue;
    repos.set(s.repo, [...(repos.get(s.repo) ?? []), s]);
  }
  return [
    ...(top.length ? [{ id: PINNED_GROUP, label: 'Pinned', sessions: top }] : []),
    ...[...repos].map(([repo, sessions]) => ({ id: `repo:${repo}`, label: repo, sessions })),
  ];
}

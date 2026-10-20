import type { Session, SessionSort } from '@joc/protocol';

export interface SessionGroup {
  /** Stable key, also what a collapsed group is remembered by. */
  id: string;
  label: string;
  sessions: Session[];
}

export const PINNED_GROUP = 'pinned';
export const REVIEWS_GROUP = 'reviews';

/** The sort menu's orders, as the design names them. */
export const SORT_OPTIONS: { id: SessionSort; label: string; desc: string }[] = [
  { id: 'state', label: 'State', desc: 'Needs you first' },
  { id: 'activity', label: 'Last activity', desc: 'Newest first' },
  { id: 'name', label: 'Name', desc: 'A to Z' },
  { id: 'seen', label: 'First seen', desc: 'Earliest today' },
];

const STATE_RANK: Record<Session['state'], number> = {
  needs: 0,
  working: 1,
  background: 2,
  idle: 3,
  offline: 4,
};

/** When it last did something: its last state report, or its last report from older servers. */
export const activeAt = (s: Session) => Date.parse(s.activeAt ?? s.updatedAt);

const UNTITLED = 'New session';
const byName = (a: Session, b: Session) =>
  (a.title ?? UNTITLED).localeCompare(b.title ?? UNTITLED, undefined, { numeric: true });
const bySeen = (a: Session, b: Session) => Date.parse(a.startedAt) - Date.parse(b.startedAt);

/**
 * Orders sessions within a group. State: needs you, working, in background, idle, offline; ties
 * keep first-seen order, so two sessions in one state never swap as they work. Last activity:
 * newest first. Name: A to Z, numbers in natural order. First seen: earliest first.
 */
export function compareSessions(sort: SessionSort): (a: Session, b: Session) => number {
  switch (sort) {
    case 'state':
      return (a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || bySeen(a, b);
    case 'activity':
      return (a, b) => activeAt(b) - activeAt(a) || bySeen(a, b);
    case 'name':
      return (a, b) => byName(a, b) || bySeen(a, b);
    case 'seen':
      return bySeen;
  }
}

/** A review whose session is over or between turns: it did what it was asked. */
export const reviewDone = (s: Session) => s.state === 'idle' || s.state === 'offline';

/**
 * The session list's groups: Reviews first, then the sessions you pinned in the order you pinned
 * them, then each repo A to Z, so groups never reorder as sessions update. Within Reviews and
 * each repo, `sort` orders the sessions; in Reviews finished ones follow the live ones, in the
 * order they finished. A session shows in one group only: pinned beats review beats repo.
 */
export function groupSessions(
  list: Session[],
  pinned: string[],
  sort: SessionSort = 'seen',
): SessionGroup[] {
  const byId = new Map(list.map((s) => [s.id, s]));
  const top = pinned.flatMap((id) => byId.get(id) ?? []);
  const reviews: Session[] = [];
  const repos = new Map<string, Session[]>();
  for (const s of list) {
    if (pinned.includes(s.id)) continue;
    if (s.review) reviews.push(s);
    else repos.set(s.repo, [...(repos.get(s.repo) ?? []), s]);
  }
  const compare = compareSessions(sort);
  const live = reviews.filter((s) => !reviewDone(s)).sort(compare);
  const done = reviews.filter(reviewDone).sort((a, b) => activeAt(a) - activeAt(b));
  return [
    ...(reviews.length
      ? [{ id: REVIEWS_GROUP, label: 'Reviews', sessions: [...live, ...done] }]
      : []),
    ...(top.length ? [{ id: PINNED_GROUP, label: 'Pinned', sessions: top }] : []),
    ...[...repos]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([repo, sessions]) => ({
        id: `repo:${repo}`,
        label: repo,
        sessions: sessions.sort(compare),
      })),
  ];
}

/**
 * The groups as shown: the same groups, each row in the place `order` holds it in. Rows `order`
 * doesn't know yet join the end of their group.
 */
export function arrangeGroups(groups: SessionGroup[], order: string[]): SessionGroup[] {
  const at = new Map(order.map((id, i) => [id, i]));
  const place = (s: Session) => at.get(s.id) ?? Number.POSITIVE_INFINITY;
  return groups.map((g) => ({
    ...g,
    // A stable sort: new rows keep the group's own order among themselves.
    sessions: [...g.sessions].sort((a, b) => {
      const pa = place(a);
      const pb = place(b);
      return pa === pb ? 0 : pa < pb ? -1 : 1;
    }),
  }));
}

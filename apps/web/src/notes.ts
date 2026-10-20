import {
  type Alert,
  channelsOf,
  type GitHubNotification,
  type NotificationKind,
  type Prefs,
  type Session,
} from '@joc/protocol';
import { plain } from './plain.ts';

// The notification center's one list: sessions waiting on you, JOC's alerts and the person's
// GitHub notifications, as notes. This module is UI-free so its rules are tested in node: what
// each note says, where it groups, what counts, and how the panel's list holds still while read.

/** Where a note groups in the panel, in this order. */
export type NoteGroup = 'needs' | 'reviews' | 'activity';

export const GROUP_LABEL: Record<NoteGroup, string> = {
  needs: 'Needs you',
  reviews: 'Reviews',
  activity: 'Activity',
};

const GROUPS: NoteGroup[] = ['needs', 'reviews', 'activity'];

/** NotificationRow's lead, spelt here so this module stays UI-free. */
export type NoteLead =
  | { state: 'needs' | 'idle' }
  | { ci: 'fail' }
  | { icon: 'pr' | 'comment' | 'person' | 'inbox' };

export interface Note {
  /** `session:<id>`, `alert:<id>` or `github:<thread id>`. */
  id: string;
  kind: NotificationKind;
  group: NoteGroup;
  /** On the panel's GitHub tab. */
  github: boolean;
  lead: NoteLead;
  title: string;
  /** In mono: `atlas-web#12`, or the repo's name. */
  source: string;
  text?: string;
  /** The text is a command or a tool call: mono. */
  mono?: boolean;
  at: string;
  unread: boolean;
  /** A session waiting on you now: pinned, never read or cleared by hand. */
  live?: boolean;
  /** Where opening it goes: a session here, or GitHub in a new tab. */
  href: string;
  external: boolean;
  repo: string;
  number?: number;
  /** The session it's about, if any. */
  sessionId?: string;
  /** For a failed CI run: the branch it ran on, to find the session working there. */
  branch?: string;
  /** The alert and GitHub threads that marking it read or clearing it changes. */
  alertId?: string;
  threadIds: string[];
}

const repoName = (repo: string) => repo.split('/')[1] ?? repo;
const sessionHref = (id: string) => `/?session=${encodeURIComponent(id)}`;
const UNTITLED = 'New session';

const PERMISSION = /^Permission: /;

/** A session's or a `needs` alert's waiting: a question, or a tool call it wants to make. */
function waiting(activity: string | undefined): {
  kind: 'question' | 'permission';
  text?: string;
} {
  if (activity && PERMISSION.test(activity)) {
    return { kind: 'permission', text: plain(activity.replace(PERMISSION, '')) };
  }
  return { kind: 'question', text: activity ? plain(activity) : undefined };
}

/**
 * The sessions needing you, as notes. `since` gives each the time it started waiting (its
 * unread `needs` alert), so the list doesn't reorder on every report.
 */
export function needsNotes(sessions: Session[], alerts: Alert[] = []): Note[] {
  return sessions
    .filter((s) => s.state === 'needs')
    .map((s) => {
      const { kind, text } = waiting(s.activity);
      const title = s.title ?? UNTITLED;
      const since = alerts.find((a) => a.kind === 'needs' && a.sessionId === s.id && !a.read);
      return {
        id: `session:${s.id}`,
        kind,
        group: 'needs',
        github: false,
        lead: { state: 'needs' },
        title: kind === 'permission' ? `${title} wants permission` : `${title} needs you`,
        source: repoName(s.repo),
        text,
        mono: kind === 'permission',
        at: since?.at ?? s.updatedAt,
        unread: true,
        live: true,
        href: sessionHref(s.id),
        external: false,
        repo: s.repo,
        sessionId: s.id,
        threadIds: [],
      };
    });
}

/**
 * JOC's alert as a note. A `needs` alert is a record of a session that waited on you: the
 * history shows it; the panel has the live session instead.
 */
export function alertNote(a: Alert): Note {
  const base = {
    id: `alert:${a.id}`,
    at: a.at,
    unread: !a.read,
    repo: a.repo,
    alertId: a.id,
    threadIds: [],
  };
  if (a.kind === 'review') {
    return {
      ...base,
      kind: 'review',
      group: 'reviews',
      github: true,
      lead: { icon: 'pr' },
      title: a.number ? `Review requested on #${a.number}` : 'Review requested',
      source: a.number ? `${repoName(a.repo)}#${a.number}` : repoName(a.repo),
      text: a.detail ? `${a.title} · ${a.detail}` : a.title,
      href: a.url ?? `https://github.com/${a.repo}/pull/${a.number}`,
      external: true,
      number: a.number,
    };
  }
  const session = {
    ...base,
    github: false,
    source: repoName(a.repo),
    href: sessionHref(a.sessionId ?? ''),
    external: false,
    sessionId: a.sessionId,
  };
  if (a.kind === 'finished') {
    return {
      ...session,
      kind: 'finished',
      group: 'activity',
      lead: { state: 'idle' },
      title: `${a.title} finished a turn`,
      text: a.detail && plain(a.detail),
    };
  }
  const { kind, text } = waiting(a.detail);
  return {
    ...session,
    kind,
    group: 'needs',
    lead: { state: 'needs' },
    title: kind === 'permission' ? `${a.title} wanted permission` : `${a.title} needed you`,
    text,
    mono: kind === 'permission',
  };
}

const MENTIONS = ['mention', 'team_mention'];

/** What a thread's note is about. */
function threadKind(t: GitHubNotification): NotificationKind {
  if (t.alert === 'ci-failed') return 'ci-failed';
  if (t.reason === 'review_requested') return 'review';
  if (MENTIONS.includes(t.reason) || t.reason === 'comment') return 'mention';
  return 'github';
}

const OTHER_VERBS = new Map([
  ['assign', 'Assigned to you'],
  ['author', 'Activity on your thread'],
  ['state_change', 'State changed'],
  ['subscribed', 'Activity on a thread you watch'],
  ['manual', 'Activity on a thread you watch'],
  ['invitation', 'You were invited'],
  ['security_alert', 'Security alert'],
  ['ci_activity', 'CI finished'],
]);

/** One of the person's unread GitHub threads as a note. */
export function threadNote(t: GitHubNotification): Note {
  const kind = threadKind(t);
  const on = t.number ? ` on #${t.number}` : '';
  const base = {
    id: `github:${t.id}`,
    kind,
    github: true,
    source: t.number ? `${repoName(t.repo)}#${t.number}` : repoName(t.repo),
    at: t.updatedAt,
    unread: true,
    href: t.url,
    external: true,
    repo: t.repo,
    number: t.number,
    branch: t.branch,
    threadIds: [t.id],
  };
  switch (kind) {
    case 'ci-failed':
      return {
        ...base,
        group: 'activity',
        lead: { ci: 'fail' },
        title: `CI failed${on || (t.branch ? ` on ${t.branch}` : '')}`,
        text: t.title,
      };
    case 'review':
      return {
        ...base,
        group: 'reviews',
        lead: { icon: 'pr' },
        title: `Review requested${on}`,
        text: t.title,
      };
    case 'mention':
      return {
        ...base,
        group: 'reviews',
        lead: { icon: 'comment' },
        title: t.reason === 'comment' ? `New comment${on}` : `You were mentioned${on}`,
        text: t.title,
      };
    default:
      return {
        ...base,
        group: 'activity',
        lead: {
          icon: t.reason === 'assign' ? 'person' : t.type === 'PullRequest' ? 'pr' : 'inbox',
        },
        title: t.title,
        text: OTHER_VERBS.get(t.reason) ?? 'Activity',
      };
  }
}

const prKey = (repo: string, number: number | undefined) => `${repo}#${number}`;

/**
 * Every note: sessions waiting now, then JOC's alerts and the GitHub threads, newest first. A
 * pull request asking for review both ways is one note that marks both read. `records` adds the
 * answered `needs` alerts, for the history.
 */
export function allNotes(
  sessions: Session[],
  alerts: Alert[],
  threads: GitHubNotification[],
  records = false,
): Note[] {
  const waitingNow = new Set(sessions.filter((s) => s.state === 'needs').map((s) => s.id));
  // A needs alert still waiting is the live session's note; once answered it's a record.
  const fromAlerts = alerts
    .filter((a) => a.kind !== 'needs' || (records && !(a.sessionId && waitingNow.has(a.sessionId))))
    .map(alertNote);
  const reviews = new Map(
    fromAlerts.filter((n) => n.kind === 'review').map((n) => [prKey(n.repo, n.number), n]),
  );
  const fromThreads: Note[] = [];
  for (const t of threads) {
    const twin = t.reason === 'review_requested' ? reviews.get(prKey(t.repo, t.number)) : undefined;
    if (twin) {
      twin.threadIds.push(t.id);
      // Unread on GitHub still: the note is too.
      twin.unread = true;
    } else {
      fromThreads.push(threadNote(t));
    }
  }
  const rest = [...fromAlerts, ...fromThreads].sort(newestFirst);
  return [...needsNotes(sessions, alerts), ...rest];
}

const newestFirst = (a: Note, b: Note) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0);

/** The notes the panel shows: live sessions always, the rest by the person's Panel choice. */
export const panelNotes = (notes: Note[], prefs: Prefs) =>
  notes.filter((n) => n.live || channelsOf(prefs, n.kind).panel);

export type NoteTab = 'all' | 'needs' | 'github';

export const inTab = (n: Note, tab: NoteTab) =>
  tab === 'all' || (tab === 'needs' ? n.group === 'needs' : n.github);

/** The notes in their groups, in the panel's order: needs you, reviews, activity. */
export function groupNotes<T extends Pick<Note, 'group'>>(notes: T[]): [NoteGroup, T[]][] {
  return GROUPS.map((g) => [g, notes.filter((n) => n.group === g)] as [NoteGroup, T[]]).filter(
    ([, list]) => list.length > 0,
  );
}

/** Ordered as the panel shows them: by group, newest first in each. */
const panelOrder = (notes: Note[]) =>
  groupNotes([...notes].sort(newestFirst)).flatMap(([, list]) => list.map((n) => n.id));

export interface Held {
  /** The ids on show, in order; ids gone from `latest` are blank slots. */
  ids: string[];
  /** New ids waiting behind the arrivals pill. */
  waiting: string[];
}

/**
 * The panel's list after the latest notes, kept calm. While `arrivals` are held (the pointer in
 * the list, or the list scrolled) new notes wait and nothing moves; otherwise they take their
 * place. While `slots` are held (the pointer in the panel) a note that left keeps its space.
 */
export function hold(
  shown: Held | undefined,
  latest: Note[],
  { arrivals, slots }: { arrivals: boolean; slots: boolean },
): Held {
  if (!shown) return { ids: panelOrder(latest), waiting: [] };
  const present = new Set(latest.map((n) => n.id));
  const known = new Set(shown.ids);
  const fresh = latest.filter((n) => !known.has(n.id));
  if (arrivals) {
    const ids = slots ? shown.ids : shown.ids.filter((id) => present.has(id));
    return { ids, waiting: fresh.map((n) => n.id) };
  }
  const order = panelOrder(latest);
  if (!slots) return { ids: order, waiting: [] };
  // Gone ones keep their place among the rest.
  const gone = shown.ids.filter((id) => !present.has(id));
  return { ids: [...order, ...gone].sort(byPlace(shown.ids, order)), waiting: [] };
}

/** Old ids keep their old order; new ones fall in by `order`. */
function byPlace(before: string[], order: string[]) {
  const was = new Map(before.map((id, i) => [id, i]));
  const now = new Map(order.map((id, i) => [id, i]));
  return (a: string, b: string) => {
    const wa = was.get(a);
    const wb = was.get(b);
    if (wa !== undefined && wb !== undefined) return wa - wb;
    return (now.get(a) ?? 0) - (now.get(b) ?? 0);
  };
}

/** The bell's numbers: sessions needing you, and every unread note on the panel. */
export function bellCounts(notes: Note[]): { needs: number; unread: number } {
  return {
    needs: notes.filter((n) => n.live).length,
    unread: notes.filter((n) => n.unread).length,
  };
}

/** `JOC`, or `(2) JOC` while two sessions need you. */
export const pageTitle = (needs: number) => (needs ? `(${needs}) JOC` : 'JOC');

/**
 * Notes that arrived since `seen` (the ids there last time), worth a toast or a desktop
 * notification: unread, and not about the session you're looking at.
 */
export function arrived(seen: Set<string>, notes: Note[], viewing?: string): Note[] {
  return notes.filter((n) => n.unread && !seen.has(n.id) && !(viewing && n.sessionId === viewing));
}

/** The prompt "Send to Claude" queues for the session on a failed CI run's branch. */
export const ciPrompt = (n: Pick<Note, 'href' | 'branch'>) =>
  `CI failed${n.branch ? ` on ${n.branch}` : ''}: ${n.href}\n\nLook at the failing checks with gh, find the cause and fix it.`;

import {
  type Alert,
  channelsOf,
  chimes,
  type GitHubNotification,
  type GitHubSnapshot,
  type NotificationKind,
  type Prefs,
  type PullRequest,
  type Session,
  type Waiting,
} from '@joc/protocol';
import { plain } from './plain.ts';

// The notification center's one list, as notes. This module is UI-free so its rules are tested
// in node: what notifies, what resolves it, what each note says, where it groups and what counts.
//
// What notifies, and nothing else (NotificationKind in @joc/protocol):
// - a session waiting on you (question or permission): gone once it's answered anywhere;
// - your review requested on a pull request: gone once it's no longer in your review-requested
//   list (you reviewed it, the request was withdrawn, it closed);
// - a mention, or a comment on your pull request: gone once you open or dismiss it;
// - CI failed on your pull request: gone once CI passes again (or it closed), or you open it;
// - off by default, a long turn that finished: gone once you open the session.
// Everything else (other GitHub activity, the record of a session that waited) is history only.
// A note that's resolved, read or dismissed is gone from the panel; the history keeps it.

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
  /** Still needs you: not read, dismissed or resolved. */
  unread: boolean;
  /** It resolved itself: answered, reviewed, CI green. */
  resolved?: boolean;
  /** Not a notification, kept for the history only. */
  historyOnly?: boolean;
  /** A session waiting on you now: pinned, never dismissed by hand. */
  live?: boolean;
  /** Where opening it goes: a session or a pull request here, or GitHub in a new tab. */
  href: string;
  external: boolean;
  repo: string;
  number?: number;
  /** The session it's about, if any. */
  sessionId?: string;
  /** What a session waiting on you now waits on, when its plugin takes answers from JOC. */
  waiting?: Waiting;
  /** For a failed CI run: the branch it ran on. */
  branch?: string;
  /** The alert and GitHub threads that opening or dismissing it reads. */
  alertId?: string;
  threadIds: string[];
}

const repoName = (repo: string) => repo.split('/')[1] ?? repo;
const sessionHref = (id: string) => `/?session=${encodeURIComponent(id)}`;
const prHref = (repo: string, number: number) =>
  `/pr?${new URLSearchParams({ repo, number: String(number) })}`;
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
      const asked = s.waiting;
      const said = waiting(s.activity);
      const kind = asked?.kind ?? said.kind;
      const text = asked?.kind === 'permission' ? asked.summary || said.text : said.text;
      const title = s.title ?? UNTITLED;
      const wants =
        asked?.kind === 'permission' && asked.tool === 'Bash'
          ? 'wants to run a command'
          : 'wants permission';
      const since = alerts.find((a) => a.kind === 'needs' && a.sessionId === s.id && !a.read);
      return {
        id: `session:${s.id}`,
        kind,
        group: 'needs',
        github: false,
        lead: { state: 'needs' },
        title: kind === 'permission' ? `${title} ${wants}` : `${title} needs you`,
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
        waiting: asked,
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
  if (a.kind === 'review' || a.kind === 'ci-failed') {
    const pr = {
      ...base,
      github: true,
      source: a.number ? `${repoName(a.repo)}#${a.number}` : repoName(a.repo),
      href: a.number ? prHref(a.repo, a.number) : (a.url ?? `https://github.com/${a.repo}`),
      external: !a.number,
      number: a.number,
    };
    if (a.kind === 'review') {
      return {
        ...pr,
        kind: 'review',
        group: 'reviews',
        lead: { icon: 'pr' },
        title: a.number ? `Review requested on #${a.number}` : 'Review requested',
        text: a.detail ? `${a.title} · ${a.detail}` : a.title,
      };
    }
    return {
      ...pr,
      kind: 'ci-failed',
      group: 'activity',
      lead: { ci: 'fail' },
      title: a.number ? `CI failed on #${a.number}` : 'CI failed',
      text: a.title,
      branch: a.branch,
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
  if (a.kind === 'long-turn') {
    return {
      ...session,
      kind: 'long-turn',
      group: 'activity',
      lead: { state: 'idle' },
      title: `${a.title} finished`,
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
    // A record: the live session is the notification.
    historyOnly: true,
  };
}

const MENTIONS = ['mention', 'team_mention'];

/** What a thread's note is about. */
function threadKind(t: GitHubNotification): NotificationKind {
  if (t.alert === 'ci-failed') return 'ci-failed';
  if (t.reason === 'review_requested') return 'review';
  if (MENTIONS.includes(t.reason) || t.reason === 'comment') return 'mention';
  if (t.reason === 'author' && t.type === 'PullRequest') return 'mention';
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

/** One of the person's GitHub threads as a note: unread, unless read here. */
export function threadNote(t: GitHubNotification, unread = true): Note {
  const kind = threadKind(t);
  const on = t.number ? ` on #${t.number}` : '';
  const base = {
    id: `github:${t.id}`,
    kind,
    github: true,
    source: t.number ? `${repoName(t.repo)}#${t.number}` : repoName(t.repo),
    at: t.updatedAt,
    unread,
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
        // Reviewed here, in JOC.
        ...(t.number ? { href: prHref(t.repo, t.number), external: false } : {}),
      };
    case 'mention':
      return {
        ...base,
        group: 'reviews',
        lead: { icon: 'comment' },
        title:
          t.reason === 'author'
            ? `New activity on your #${t.number}`
            : t.reason === 'comment'
              ? `New comment${on}`
              : `You were mentioned${on}`,
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
        historyOnly: true,
      };
  }
}

/** The person's pull requests as their last good GitHub read had them, and when. */
interface Pulls {
  reviewRequested: PullRequest[];
  mine: PullRequest[];
  at: number;
}

function pullsOf(github: GitHubSnapshot | undefined): Pulls | undefined {
  if (github?.state !== 'reported' || github.status !== 'ok') return undefined;
  return {
    reviewRequested: github.reviewRequested,
    mine: github.mine,
    at: Date.parse(github.updatedAt),
  };
}

type About = Pick<Note, 'repo' | 'number' | 'branch' | 'at'>;

/**
 * A review request is resolved once the pull request isn't in the review-requested list. For
 * an alert (raised from that list), only a read after it counts; a GitHub thread keeps its
 * reason for good, so the list alone says whether it's still asked.
 */
export function reviewResolved(n: About, pulls: Pulls | undefined, sinceOnly: boolean): boolean {
  if (!pulls || !n.number) return false;
  if (sinceOnly && pulls.at <= Date.parse(n.at)) return false;
  return !pulls.reviewRequested.some((p) => p.repo === n.repo && p.number === n.number);
}

/**
 * Failed CI is resolved once a read after it finds the pull request's CI not failing, or the
 * pull request closed. A run on a branch with no pull request waits to be opened.
 */
export function ciResolved(n: About, pulls: Pulls | undefined): boolean {
  if (!pulls || pulls.at <= Date.parse(n.at)) return false;
  const pr = pulls.mine.find(
    (p) => p.repo === n.repo && (n.number ? p.number === n.number : p.branch === n.branch),
  );
  if (!pr) return n.number !== undefined;
  return pr.ci !== 'fail';
}

const prKey = (repo: string, number: number | undefined) => `${repo}#${number}`;

export interface NoteSources {
  sessions: Session[];
  alerts: Alert[];
  threads: GitHubNotification[];
  /** The threads read here. */
  read?: ReadonlySet<string>;
  /** The person's pull requests, which resolve review requests and failed CI. */
  github?: GitHubSnapshot;
  /** Adds the answered `needs` alerts, for the history. */
  records?: boolean;
}

/**
 * Every note: sessions waiting now, then JOC's alerts and the GitHub threads, newest first. A
 * pull request asking for review (or failing CI) both ways is one note that reads both.
 */
export function allNotes({
  sessions,
  alerts,
  threads,
  read = new Set(),
  github,
  records = false,
}: NoteSources): Note[] {
  const pulls = pullsOf(github);
  const waitingNow = new Set(sessions.filter((s) => s.state === 'needs').map((s) => s.id));
  // A needs alert still waiting is the live session's note; once answered it's a record.
  const fromAlerts = alerts
    .filter((a) => a.kind !== 'needs' || (records && !(a.sessionId && waitingNow.has(a.sessionId))))
    .map(alertNote);
  // Newest first: a thread twins with the latest alert about its pull request.
  const reviews = new Map<string, Note>();
  for (const n of fromAlerts) {
    if (n.kind === 'review' && !reviews.has(prKey(n.repo, n.number))) {
      reviews.set(prKey(n.repo, n.number), n);
    }
  }
  const failures = fromAlerts.filter((n) => n.kind === 'ci-failed');
  const fromThreads: Note[] = [];
  for (const t of threads) {
    const twin =
      t.reason === 'review_requested'
        ? reviews.get(prKey(t.repo, t.number))
        : t.alert === 'ci-failed'
          ? failures.find(
              (n) =>
                n.repo === t.repo && (t.number ? n.number === t.number : n.branch === t.branch),
            )
          : undefined;
    if (twin) {
      twin.threadIds.push(t.id);
      // Unread on GitHub still: the note is too.
      if (!read.has(t.id)) twin.unread = true;
    } else {
      fromThreads.push(threadNote(t, !read.has(t.id)));
    }
  }
  const rest = [...fromAlerts, ...fromThreads].map((n) => {
    const resolved =
      n.kind === 'review'
        ? reviewResolved(n, pulls, n.alertId !== undefined)
        : n.kind === 'ci-failed'
          ? ciResolved(n, pulls)
          : false;
    return resolved ? { ...n, resolved, unread: false } : n;
  });
  return [...needsNotes(sessions, alerts), ...rest.sort(newestFirst)];
}

const newestFirst = (a: Note, b: Note) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0);

/**
 * The notes the panel shows: what still needs you. Sessions waiting always; the rest while
 * unread, by the person's Panel choice.
 */
export const panelNotes = (notes: Note[], prefs: Prefs) =>
  notes.filter((n) => n.live || (n.unread && !n.historyOnly && channelsOf(prefs, n.kind).panel));

/** What Clear all dismisses: everything on the panel but the sessions waiting on you. */
export const clearable = (notes: Note[]) => notes.filter((n) => !n.live && n.unread);

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
  /** The ids on show, in order. */
  ids: string[];
  /** New ids waiting behind the arrivals pill. */
  waiting: string[];
}

/**
 * The panel's list after the latest notes. A note that went leaves at once. While `arrivals`
 * are held (the pointer in the list, or the list scrolled) new notes wait behind the pill
 * rather than land above what you're reading; otherwise they take their place.
 */
export function hold(shown: Held | undefined, latest: Note[], arrivals: boolean): Held {
  if (!shown || !arrivals) return { ids: panelOrder(latest), waiting: [] };
  const present = new Set(latest.map((n) => n.id));
  const known = new Set(shown.ids);
  return {
    ids: shown.ids.filter((id) => present.has(id)),
    waiting: latest.filter((n) => !known.has(n.id)).map((n) => n.id),
  };
}

/**
 * The rows to draw: `current`, with the `leaving` ones (gone from it, fading out) back where
 * they were in `before`, each just after the row it followed.
 */
export function withLeaving(
  before: string[],
  current: string[],
  leaving: ReadonlySet<string>,
): string[] {
  if (!leaving.size) return current;
  const out = current.filter((id) => !leaving.has(id));
  for (const [i, id] of before.entries()) {
    if (!leaving.has(id) || out.includes(id)) continue;
    let after = -1;
    for (let j = i - 1; j >= 0 && after < 0; j--) after = out.indexOf(before[j] ?? '');
    out.splice(after + 1, 0, id);
  }
  return out;
}

/** The bell's numbers: sessions needing you, and every note still needing you. */
export function bellCounts(notes: Note[]): { needs: number; unread: number } {
  return {
    needs: notes.filter((n) => n.live).length,
    unread: notes.filter((n) => n.unread).length,
  };
}

/** `JOC`, or `(2) JOC` while two sessions need you. */
export const pageTitle = (needs: number) => (needs ? `(${needs}) JOC` : 'JOC');

/**
 * Notes that arrived since `seen` (the ids there last time), worth a toast, a sound or a desktop
 * notification: still needing you, a notification, and not about the session you're looking at.
 */
export function arrived(seen: Set<string>, notes: Note[], viewing?: string): Note[] {
  return notes.filter(
    (n) => n.unread && !n.historyOnly && !seen.has(n.id) && !(viewing && n.sessionId === viewing),
  );
}

/** What the arrivals ask for, by the person's choices: their toasts, and whether to chime. */
export function attention(news: Note[], prefs: Prefs): { toasts: Note[]; chime: boolean } {
  return {
    toasts: news.filter((n) => channelsOf(prefs, n.kind).toast),
    chime: news.some((n) => chimes(prefs, n.kind)),
  };
}

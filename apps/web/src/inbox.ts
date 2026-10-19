import type { GitHubNotification } from '@joc/protocol';

/** InboxRow's `mark`, spelt here so this module (and its node tests) stay free of the UI. */
type InboxMark = 'review' | 'mention' | 'ci-failed' | 'comment' | 'assign' | 'other';

/** One of the Inbox's groups, and how its rows are marked. */
export interface InboxGroup {
  label: string;
  mark: InboxMark;
  reasons: string[];
}

// In the order they show: what needs you first.
const GROUPS: InboxGroup[] = [
  { label: 'Review requested', mark: 'review', reasons: ['review_requested'] },
  { label: 'Mentioned', mark: 'mention', reasons: ['mention', 'team_mention'] },
  { label: 'CI', mark: 'other', reasons: ['ci_activity'] },
  { label: 'Commented', mark: 'comment', reasons: ['comment'] },
  { label: 'Assigned', mark: 'assign', reasons: ['assign'] },
  { label: 'Your threads', mark: 'other', reasons: ['author'] },
  { label: 'State changes', mark: 'other', reasons: ['state_change'] },
  { label: 'Subscribed', mark: 'other', reasons: ['subscribed', 'manual'] },
];
const OTHER: InboxGroup = { label: 'Other', mark: 'other', reasons: [] };

const groupOf = (reason: string) => GROUPS.find((g) => g.reasons.includes(reason)) ?? OTHER;

/** A row's mark: its group's, except that failed CI shows the CI cross. */
export const markOf = (t: GitHubNotification): InboxMark =>
  t.alert === 'ci-failed' ? 'ci-failed' : groupOf(t.reason).mark;

/** A thread on the Inbox: still unread, or marked read while the page was open. */
export type InboxThread = GitHubNotification & { read: boolean };

/**
 * The page's list after a new snapshot, kept calm: rows keep their place and update in place,
 * a thread that left the unread set stays where it was, marked read, and new ones go last.
 */
export function mergeThreads(shown: InboxThread[], unread: GitHubNotification[]): InboxThread[] {
  const latest = new Map(unread.map((t) => [t.id, t]));
  const kept = shown.map((t) => {
    const now = latest.get(t.id);
    return now ? { ...now, read: false } : { ...t, read: true };
  });
  const known = new Set(shown.map((t) => t.id));
  const added = unread.filter((t) => !known.has(t.id)).map((t) => ({ ...t, read: false }));
  return [...kept, ...added];
}

/** The threads by group, in the groups' fixed order; empty groups are left out. */
export function groupThreads(threads: InboxThread[]): [InboxGroup, InboxThread[]][] {
  const groups = new Map<InboxGroup, InboxThread[]>([...GROUPS, OTHER].map((g) => [g, []]));
  for (const t of threads) groups.get(groupOf(t.reason))?.push(t);
  return [...groups].filter(([, list]) => list.length > 0);
}

const VERBS = new Map([
  ['review_requested', 'Review requested from you'],
  ['mention', 'You were mentioned'],
  ['team_mention', 'Your team was mentioned'],
  ['comment', 'New comment'],
  ['assign', 'Assigned to you'],
  ['author', 'Activity on your thread'],
  ['state_change', 'State changed'],
  ['subscribed', 'Activity on a thread you watch'],
  ['manual', 'Activity on a thread you watch'],
  ['invitation', 'You were invited'],
  ['security_alert', 'Security alert'],
]);

const KINDS = new Map([
  ['PullRequest', 'pull request'],
  ['Issue', 'issue'],
  ['Discussion', 'discussion'],
  ['Commit', 'commit'],
  ['Release', 'release'],
]);

/**
 * What happened, in a few words: "Review requested from you", "CI failed". GitHub's feed
 * doesn't say who did it, so the row says what and when.
 */
export function verbOf(t: GitHubNotification): string {
  if (t.reason === 'ci_activity') return t.alert === 'ci-failed' ? 'CI failed' : 'CI finished';
  const verb = VERBS.get(t.reason) ?? 'Activity';
  const kind = KINDS.get(t.type);
  return kind ? `${verb} · ${kind}` : verb;
}

/** `repo#number`, or the repo alone. */
export const referenceOf = (t: GitHubNotification) => {
  const repo = t.repo.split('/')[1] ?? t.repo;
  return t.number ? `${repo}#${t.number}` : repo;
};

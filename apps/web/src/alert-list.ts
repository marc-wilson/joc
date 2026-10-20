import type { Alert, GitHubNotification } from '@joc/protocol';
import { plain } from './plain.ts';

// JOC's own alerts (the server keeps them): how the Inbox shows them, how the list stays calm
// while it's read, and what counts as waiting on the person.

/** InboxRow's props for an alert, spelt here so this module (and its node tests) stay UI-free. */
export interface AlertRow {
  mark: 'needs' | 'finished' | 'review';
  href: string;
  external: boolean;
  reference: string;
  verb: string;
}

const repoName = (repo: string) => repo.split('/')[1] ?? repo;

const withDetail = (verb: string, detail: string | undefined) =>
  detail ? `${verb}: ${plain(detail)}` : verb;

export function alertRow(a: Alert): AlertRow {
  if (a.kind === 'review') {
    return {
      mark: 'review',
      href: a.url ?? `https://github.com/${a.repo}/pull/${a.number}`,
      external: true,
      reference: a.number ? `${repoName(a.repo)}#${a.number}` : repoName(a.repo),
      verb: a.detail ? `Review requested · opened by ${a.detail}` : 'Review requested',
    };
  }
  return {
    mark: a.kind,
    href: `/?session=${encodeURIComponent(a.sessionId ?? '')}`,
    external: false,
    reference: repoName(a.repo),
    verb: withDetail(a.kind === 'needs' ? 'Needed you' : 'Finished', a.detail),
  };
}

/**
 * The page's list after the server's latest, kept calm: rows keep their place and update in
 * place, cleared ones leave, and new ones wait in `fresh` until the person asks to see them.
 * The first list is shown as it comes.
 */
export function settle(
  shown: Alert[] | undefined,
  latest: Alert[],
): { shown: Alert[]; fresh: Alert[] } {
  if (!shown) return { shown: latest, fresh: [] };
  const byId = new Map(latest.map((a) => [a.id, a]));
  const known = new Set(shown.map((a) => a.id));
  return {
    shown: shown.flatMap((a) => byId.get(a.id) ?? []),
    fresh: latest.filter((a) => !known.has(a.id)),
  };
}

const prKey = (repo: string, number: number | undefined) => `${repo}#${number}`;

/**
 * How many things wait on the person, for the tab's title: sessions needing them now, unread
 * review requests and GitHub threads worth interrupting for. A review request that's both
 * counts once.
 */
export function waitingCount(
  needing: number,
  alerts: Alert[],
  threads: GitHubNotification[],
): number {
  const reviews = new Set(
    alerts.filter((a) => !a.read && a.kind === 'review').map((a) => prKey(a.repo, a.number)),
  );
  const others = threads.filter(
    (t) => t.alert && !(t.alert === 'review' && reviews.has(prKey(t.repo, t.number))),
  );
  return needing + reviews.size + others.length;
}

/** `JOC`, or `(3) JOC` while three things wait on the person. */
export const pageTitle = (waiting: number) => (waiting ? `(${waiting}) JOC` : 'JOC');

/** What a toast for the alert says. */
export function toastText(a: Alert): { title: string; body: string; action: string } {
  if (a.kind === 'review') {
    return {
      title: 'Review requested',
      body: `${alertRow(a).reference} ${a.title}`,
      action: 'Open on GitHub',
    };
  }
  return {
    title: a.kind === 'needs' ? 'Needs you' : 'Finished',
    body: a.detail ? `${a.title}: ${plain(a.detail)}` : a.title,
    action: 'Open session',
  };
}

/**
 * The unread alerts that arrived since `seen` and are worth a toast: a session needing the
 * person, unless it's the one they're looking at, or a review request. Adds them to `seen`.
 */
export function toastable(seen: Set<string>, alerts: Alert[], viewing?: string): Alert[] {
  const fresh = alerts.filter((a) => !seen.has(a.id));
  for (const a of fresh) seen.add(a.id);
  return fresh.filter(
    (a) => !a.read && (a.kind === 'review' || (a.kind === 'needs' && a.sessionId !== viewing)),
  );
}

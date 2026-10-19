import type { GitHubNotification, NotificationAlert, Session, SessionState } from '@joc/protocol';
import { plain } from './plain.ts';

// What the opt-in browser notifications say, and when (notify.ts shows them): a review request,
// a mention, CI failing on your PR, a session that needs you. Each fires once: what was already
// waiting when the page loaded isn't news, and the `tag` folds the same news from another open
// tab into one.

export interface BrowserAlert {
  /** Same news, same tag: the browser shows it once. */
  tag: string;
  title: string;
  body: string;
  /** Where a click goes: GitHub in a new tab, or a session here. */
  href: string;
  external: boolean;
}

const HEADINGS: Record<NotificationAlert, string> = {
  review: 'Review requested',
  mention: 'You were mentioned',
  'ci-failed': 'CI failed',
};

const threadKey = (t: GitHubNotification) => `github:${t.id}:${t.alert}`;

export function threadAlert(t: GitHubNotification): BrowserAlert {
  const where = t.number ? `${t.repo}#${t.number}` : t.repo;
  return {
    tag: threadKey(t),
    title: t.alert ? HEADINGS[t.alert] : 'GitHub',
    body: `${where} ${t.title}`,
    href: t.url,
    external: true,
  };
}

export function sessionAlert(s: Session): BrowserAlert {
  return {
    tag: `session:${s.id}`,
    title: 'Needs you',
    body: `${s.title ?? 'New session'}${s.activity ? `: ${plain(s.activity)}` : ''}`,
    href: `/?session=${encodeURIComponent(s.id)}`,
    external: false,
  };
}

/** The threads with an alert not seen yet; adds them to `seen`. */
export function freshThreads(
  seen: Set<string>,
  threads: GitHubNotification[],
): GitHubNotification[] {
  const fresh = threads.filter((t) => t.alert && !seen.has(threadKey(t)));
  for (const t of fresh) seen.add(threadKey(t));
  return fresh;
}

/** Sessions that went to `needs` since `before` (a session first seen needing you counts). */
export function newlyNeeding(before: Map<string, SessionState>, sessions: Session[]): Session[] {
  return sessions.filter((s) => s.state === 'needs' && before.get(s.id) !== 'needs');
}

/** The seen keys of what's already there, so it doesn't fire. */
export const seenNow = (threads: GitHubNotification[]) =>
  new Set(threads.filter((t) => t.alert).map(threadKey));

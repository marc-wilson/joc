// The person's unread GitHub notifications, read through `gh` the way GitHub asks a poller to:
// never more often than its X-Poll-Interval (a minute at least), and conditionally, so "nothing
// new" is a cheap 304. One read per machine, whichever session's sync comes due first, as in
// github.ts. Each read first marks read on GitHub the threads the person marked in the dashboard.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  GitHubNotification,
  GitHubReport,
  NotificationAlert,
  NotificationsReport,
} from '@joc/protocol';

const MIN_INTERVAL_S = 60;
const PER_PAGE = 50;
/** 4 pages of 50: protocol's MAX_NOTIFICATIONS. */
const MAX_PAGES = 4;
/** How long a notified thread is remembered, so it never notifies twice. */
const NOTIFIED_KEPT_MS = 30 * 24 * 60 * 60_000;

const folder = () => join(homedir(), '.claude', 'joc');
export const defaultFiles = () => ({
  stamp: join(folder(), 'notifications-read.json'),
  notified: join(folder(), 'notified.json'),
});
export type Files = ReturnType<typeof defaultFiles>;

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // Not written yet, or unreadable: start over.
    return undefined;
  }
}

function writeJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

/** When this machine last read the feed, how long GitHub asked it to wait, and what it saw. */
export interface Stamp {
  at: number;
  intervalS: number;
  /** The feed's Last-Modified from the last read the server took. */
  lastModified?: string;
}

function readStamp(file: string): Stamp {
  const raw = readJson(file);
  const value = (key: string) =>
    raw && typeof raw === 'object' ? Object.entries(raw).find(([k]) => k === key)?.[1] : undefined;
  const at = value('at');
  const intervalS = value('intervalS');
  const lastModified = value('lastModified');
  return {
    at: typeof at === 'number' ? at : 0,
    intervalS: typeof intervalS === 'number' ? Math.max(intervalS, MIN_INTERVAL_S) : MIN_INTERVAL_S,
    lastModified: typeof lastModified === 'string' ? lastModified : undefined,
  };
}

/** The stamp when a read is due across every session on this machine, claiming it; else none. */
export function notificationsDue(now: number, file: string): Stamp | undefined {
  const stamp = readStamp(file);
  if (now - stamp.at < stamp.intervalS * 1000) return undefined;
  writeJson(file, { ...stamp, at: now });
  return stamp;
}

/** A `gh api -i` answer: its status line, headers and body. */
export interface Included {
  status: number;
  headers: Map<string, string>;
  body: string;
}

export function parseIncluded(stdout: string): Included | undefined {
  const status = stdout.match(/^HTTP\/[\d.]+ (\d{3})/);
  if (!status) return undefined;
  const end = stdout.search(/\r?\n\r?\n/);
  const head = end < 0 ? stdout : stdout.slice(0, end);
  const headers = new Map<string, string>();
  for (const line of head.split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0)
      headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { status: Number(status[1]), headers, body: end < 0 ? '' : stdout.slice(end).trim() };
}

// The slice of GitHub's REST answer this reads. It's external input: every field is checked.
export interface ApiThread {
  id?: string;
  reason?: string;
  updated_at?: string;
  subject?: { title?: string; url?: string | null; type?: string };
  repository?: { full_name?: string; html_url?: string };
}

const PAGES = new Map([
  ['pulls', 'pull'],
  ['issues', 'issues'],
  ['commits', 'commit'],
  ['discussions', 'discussions'],
]);

/** The github.com page for a thread's API subject URL: a PR, issue, commit or the repo's. */
export function webUrl(subjectUrl: string | null | undefined, repoUrl: string, type: string) {
  const path = subjectUrl?.match(/\/repos\/[^/]+\/[^/]+\/([a-z]+)\/([^/?#]+)$/);
  const page = path?.[1] && PAGES.get(path[1]);
  if (page && path?.[2]) return `${repoUrl}/${page}/${path[2]}`;
  if (path?.[1] === 'releases') return `${repoUrl}/releases`;
  if (type === 'CheckSuite') return `${repoUrl}/actions`;
  return repoUrl;
}

function alertFor(reason: string, title: string): NotificationAlert | undefined {
  if (reason === 'review_requested') return 'review';
  if (reason === 'mention' || reason === 'team_mention') return 'mention';
  if (reason === 'ci_activity' && /\bfail/i.test(title)) return 'ci-failed';
  return undefined;
}

/** One API thread as a notification, or undefined when it isn't a whole one. */
export function toNotification(thread: ApiThread): GitHubNotification | undefined {
  const { id, reason, updated_at: updatedAt, subject, repository } = thread;
  const repo = repository?.full_name;
  const repoUrl = repository?.html_url;
  if (!id || !/^\d+$/.test(id) || !reason || !updatedAt || !subject?.title || !subject.type) {
    return undefined;
  }
  if (!repo || !repoUrl?.startsWith('https://')) return undefined;
  const number = Number(subject.url?.match(/\/(?:pulls|issues|discussions)\/(\d+)$/)?.[1]);
  // A CI thread's title names its branch: "CI workflow run failed for fix/login branch".
  const branch =
    subject.type === 'CheckSuite' ? subject.title.match(/ for (\S+) branch$/)?.[1] : undefined;
  return {
    id,
    reason,
    title: subject.title.slice(0, 500),
    type: subject.type,
    repo,
    url: webUrl(subject.url, repoUrl, subject.type),
    updatedAt: new Date(updatedAt).toISOString(),
    number: number || undefined,
    branch,
    alert: alertFor(reason, subject.title),
  };
}

const gh = (args: string[]) =>
  spawnSync('gh', args, { encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });

export interface Feed {
  status: GitHubReport['status'];
  /** True when GitHub answered 304: nothing changed since `lastModified`. */
  notModified: boolean;
  threads: GitHubNotification[];
  more: boolean;
  lastModified?: string;
  intervalS?: number;
}

/** Reads the unread threads, newest first, or says why it couldn't. */
export function readFeed(since?: string): Feed {
  const feed: Feed = { status: 'ok', notModified: false, threads: [], more: false };
  for (let page = 1; page <= MAX_PAGES; page++) {
    // A later page failing keeps the pages read so far.
    const fail = (status: Feed['status']): Feed =>
      page === 1 ? { ...feed, status } : { ...feed, more: true };
    const conditional = page === 1 && since ? ['-H', `If-Modified-Since: ${since}`] : [];
    const run = gh([
      'api',
      '-i',
      ...conditional,
      `/notifications?per_page=${PER_PAGE}&page=${page}`,
    ]);
    if (run.error && 'code' in run.error && run.error.code === 'ENOENT')
      return fail('not-installed');
    // gh exits non-zero on a 304 too, so the status line decides.
    const answer = parseIncluded(run.stdout ?? '');
    if (!answer) {
      return fail(
        /auth login|not logged in|authentication/i.test(run.stderr ?? '') ? 'signed-out' : 'error',
      );
    }
    if (page === 1) {
      feed.lastModified = answer.headers.get('last-modified');
      const interval = Number(answer.headers.get('x-poll-interval'));
      if (interval) feed.intervalS = interval;
      if (answer.status === 304) return { ...feed, notModified: true };
    }
    if (answer.status !== 200) return fail('error');
    let threads: unknown;
    try {
      threads = JSON.parse(answer.body);
    } catch {
      return fail('error');
    }
    if (!Array.isArray(threads)) return fail('error');
    const list: ApiThread[] = threads;
    for (const thread of list) {
      const notification = toNotification(thread);
      if (notification) feed.threads.push(notification);
    }
    if (!/rel="next"/.test(answer.headers.get('link') ?? '')) return feed;
    feed.more = page === MAX_PAGES;
  }
  return feed;
}

/** Marks the threads read on GitHub; says whether any was. */
export function markRead(ids: string[]): boolean {
  let marked = false;
  for (const id of ids) {
    if (!/^\d+$/.test(id)) continue;
    if (gh(['api', '-X', 'PATCH', `/notifications/threads/${id}`]).status === 0) marked = true;
  }
  return marked;
}

/**
 * The threads worth a native notification that this machine hasn't notified yet, remembered so
 * they never notify again. The first read on a machine only remembers: what was already waiting
 * isn't news.
 */
export function newAlerts(threads: GitHubNotification[], now: number, file: string) {
  const raw = readJson(file);
  const known = new Map<string, number>(
    raw && typeof raw === 'object'
      ? Object.entries(raw).filter((e): e is [string, number] => typeof e[1] === 'number')
      : [],
  );
  const fresh = threads.filter((t) => t.alert && !known.has(`${t.id}:${t.alert}`));
  for (const t of fresh) known.set(`${t.id}:${t.alert}`, now);
  for (const [key, at] of known) if (now - at > NOTIFIED_KEPT_MS) known.delete(key);
  writeJson(file, Object.fromEntries(known));
  return raw === undefined ? [] : fresh;
}

/** What register.ts shows for a notification, through `$.ui.notify`. */
export interface NativeAlert {
  title: string;
  text: string;
}

const HEADINGS: Record<NotificationAlert, string> = {
  review: 'Review requested',
  mention: 'You were mentioned',
  'ci-failed': 'CI failed',
};

export function nativeAlert(t: GitHubNotification): NativeAlert {
  const where = t.number ? `${t.repo}#${t.number}` : t.repo;
  return { title: `JOC: ${t.alert ? HEADINGS[t.alert] : 'GitHub'}`, text: `${where} ${t.title}` };
}

type Post = (path: string, body: unknown, timeoutMs: number) => Promise<Response | undefined>;

/** Ids of a claim response; it's our own server's, but checked like any input. */
async function claimed(res: Response | undefined): Promise<string[]> {
  if (!res?.ok) return [];
  // A reply that is not JSON names no threads, so none are marked.
  const body: unknown = await res.json().catch(() => undefined);
  const ids = body && typeof body === 'object' && 'ids' in body ? body.ids : undefined;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

/**
 * One machine-wide turn, when due: marks read what the dashboard asked, reads the feed, sends
 * it if it changed, and returns what to notify. With `canNotify` false (a session no one
 * watches) nothing counts as notified, and the next read is a full one so a watched session
 * still gets to notify.
 */
export async function syncNotifications(
  post: Post,
  at: number,
  canNotify: boolean,
  files: Files = defaultFiles(),
): Promise<NativeAlert[]> {
  const stamp = notificationsDue(at, files.stamp);
  if (!stamp) return [];
  const marked = markRead(await claimed(await post('/api/notifications/reads/claim', {}, 5000)));
  const feed = readFeed(marked ? undefined : stamp.lastModified);
  const next: Stamp = { ...stamp, at, intervalS: feed.intervalS ?? stamp.intervalS };
  if (feed.notModified) {
    writeJson(files.stamp, next);
    return [];
  }
  const report: NotificationsReport = {
    at,
    status: feed.status,
    threads: feed.threads,
    more: feed.more,
  };
  const sent = await post('/api/notifications', report, 10_000);
  // Only a read the server took (and a session that can notify) makes the next one conditional.
  const lastModified = sent?.ok && canNotify ? feed.lastModified : undefined;
  writeJson(files.stamp, { ...next, lastModified });
  if (feed.status !== 'ok' || !canNotify) return [];
  return newAlerts(feed.threads, at, files.notified).map(nativeAlert);
}

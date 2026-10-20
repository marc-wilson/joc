import {
  Alert,
  type ConversationItem,
  DeleteRefused,
  Deletion,
  GitHubSnapshot,
  HistorySession,
  Launch,
  type LaunchRequest,
  NotificationsSnapshot,
  ReviewSettings,
  Session,
  SessionSettings,
} from '@joc/protocol';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { apiFetch } from './auth.ts';
import { type DiffFile, parseDiff } from './diff.ts';
import { subscribe } from './stream.ts';

const Sessions = z.array(Session);

/**
 * Live sessions, in first-seen order. `reload` reads the list afresh, for when the person changed
 * which sessions it keeps.
 */
export function useSessions(): {
  sessions: Session[];
  connected: boolean;
  reload: () => void;
  /** Sessions deleted since the list was read: they keep their place, faded, until it's read again. */
  deleted: ReadonlySet<string>;
} {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [connected, setConnected] = useState(false);
  const [deleted, setDeleted] = useState<ReadonlySet<string>>(new Set());

  useEffect(
    () =>
      subscribe((event) => {
        if (event.type === 'status') setConnected(event.connected);
        if (event.type === 'snapshot') {
          setSessions(event.sessions);
          setDeleted(new Set());
        }
        if (event.type === 'deleted') {
          setDeleted((set) => new Set([...set, event.sessionId]));
        }
        if (event.type === 'session') {
          const { session } = event;
          // Update in place so rows never move; new sessions go at the end.
          setSessions((list) =>
            list.some((s) => s.id === session.id)
              ? list.map((s) => (s.id === session.id ? session : s))
              : [...list, session],
          );
        }
      }),
    [],
  );

  const reload = () =>
    apiFetch('/api/sessions')
      .then(async (r) => {
        if (r.ok) setSessions(Sessions.parse(await r.json()));
      })
      // Unreachable for now: the next reconnect snapshot has the list.
      .catch(() => {});

  return { sessions, connected, reload, deleted };
}

/** Which sessions the live list keeps, and a way to change it. Undefined until loaded. */
export function useSessionSettings(): {
  settings: SessionSettings | undefined;
  save: (settings: SessionSettings) => Promise<boolean>;
} {
  const [settings, setSettings] = useState<SessionSettings>();
  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/settings/sessions')
      .then(async (r) => {
        if (r.ok && !cancelled) setSettings(SessionSettings.parse(await r.json()));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(next: SessionSettings): Promise<boolean> {
    try {
      const res = await apiFetch('/api/settings/sessions', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(next),
      });
      if (!res.ok) return false;
      setSettings(SessionSettings.parse(await res.json()));
      return true;
    } catch {
      return false;
    }
  }

  return { settings, save };
}

const byTime = (a: ConversationItem, b: ConversationItem) =>
  a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at < b.at ? -1 : 1;

function merge(list: ConversationItem[], incoming: ConversationItem[]): ConversationItem[] {
  const seen = new Set(list.map((i) => i.id));
  const fresh = incoming.filter((i) => !seen.has(i.id));
  return fresh.length ? [...list, ...fresh].sort(byTime) : list;
}

/**
 * A session's conversation: what the server has, plus live additions. With `task`, the steps of
 * that background subagent instead, from its own transcript.
 */
export function useConversation(sessionId: string | undefined, task?: string): ConversationItem[] {
  const [items, setItems] = useState<ConversationItem[]>([]);

  useEffect(() => {
    setItems([]);
    if (!sessionId) return;
    let cancelled = false;
    const path = `/api/sessions/${encodeURIComponent(sessionId)}`;
    const load = () =>
      apiFetch(task ? `${path}/tasks/${encodeURIComponent(task)}/messages` : `${path}/messages`)
        .then((r) => (r.ok ? (r.json() as Promise<ConversationItem[]>) : []))
        .then((loaded) => {
          if (!cancelled) setItems((list) => merge(list, loaded));
        })
        .catch(() => {});
    // Subscribe first so nothing that arrives during the fetch is lost; merge drops repeats.
    const unsubscribe = subscribe((event) => {
      if (event.type === 'messages' && event.sessionId === sessionId) {
        const mine = event.items.filter((i) => i.task === task);
        if (mine.length) setItems((list) => merge(list, mine));
      }
      // A reconnect may have missed messages.
      if (event.type === 'snapshot') void load();
    });
    void load();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [sessionId, task]);

  return items;
}

/** The current time, refreshed on an interval, for relative timestamps. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export type Changes =
  | { status: 'loading' }
  | { status: 'none' }
  | { status: 'ready'; base: string; files: DiffFile[]; truncated: boolean; updatedAt: string };

/** A session's latest diff, refetched whenever the plugin reports a new one. */
export function useChanges(sessionId: string | undefined): Changes {
  const [changes, setChanges] = useState<Changes>({ status: 'loading' });

  useEffect(() => {
    setChanges({ status: 'loading' });
    if (!sessionId) return;
    let cancelled = false;
    const load = () =>
      apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/changes`)
        .then(async (r) => {
          if (cancelled) return;
          if (!r.ok) return setChanges({ status: 'none' });
          const body = (await r.json()) as {
            base: string;
            diff: string;
            truncated: boolean;
            updatedAt: string;
          };
          setChanges({ status: 'ready', ...body, files: parseDiff(body.diff) });
        })
        .catch(() => {});
    const unsubscribe = subscribe((event) => {
      if (
        (event.type === 'changes' && event.sessionId === sessionId) ||
        event.type === 'snapshot'
      ) {
        void load();
      }
    });
    void load();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [sessionId]);

  return changes;
}

/** The person's pull requests, refetched whenever their plugin reports new ones. */
export function useGitHub(): GitHubSnapshot | undefined {
  const [github, setGitHub] = useState<GitHubSnapshot>();
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      apiFetch('/api/github')
        .then(async (r) => {
          if (r.ok && !cancelled) setGitHub(GitHubSnapshot.parse(await r.json()));
        })
        // Unreachable for now: the next github event or reconnect snapshot loads it again.
        .catch(() => {});
    const unsubscribe = subscribe((event) => {
      if (event.type === 'github' || event.type === 'snapshot') void load();
    });
    void load();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  return github;
}

/** The person's unread GitHub notifications, refetched whenever their plugin reports new ones. */
export function useNotifications(): NotificationsSnapshot | undefined {
  const [notifications, setNotifications] = useState<NotificationsSnapshot>();
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      apiFetch('/api/notifications')
        .then(async (r) => {
          if (r.ok && !cancelled) setNotifications(NotificationsSnapshot.parse(await r.json()));
        })
        // Unreachable for now: the next notifications event or reconnect snapshot loads it again.
        .catch(() => {});
    const unsubscribe = subscribe((event) => {
      if (event.type === 'notifications' || event.type === 'snapshot') void load();
    });
    void load();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  return notifications;
}

const Alerts = z.array(Alert);

/** The person's alerts, newest first, refetched whenever the server says they changed. */
export function useAlerts(): Alert[] | undefined {
  const [alerts, setAlerts] = useState<Alert[]>();
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      apiFetch('/api/alerts')
        .then(async (r) => {
          if (r.ok && !cancelled) setAlerts(Alerts.parse(await r.json()));
        })
        // Unreachable for now: the next alerts event or reconnect snapshot loads it again.
        .catch(() => {});
    const unsubscribe = subscribe((event) => {
      if (event.type === 'alerts' || event.type === 'snapshot') void load();
    });
    void load();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  return alerts;
}

/**
 * Marks alerts read or clears them: these, or all of them. False when the server didn't take
 * it.
 */
export async function changeAlerts(action: 'read' | 'clear', ids?: string[]): Promise<boolean> {
  const res = await apiFetch(ids ? `/api/alerts/${action}` : `/api/alerts/${action}-all`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ids ? { ids } : {}),
  }).catch(() => undefined); // Unreachable: reported as not done.
  return res?.ok === true;
}

/**
 * Marks the alerts about the session read while it's on screen: looking at it is reading them.
 * Each is sent once; if that fails, the notifications still have it.
 */
export function useReadWhileViewing(alerts: Alert[] | undefined, sessionId: string | undefined) {
  const sent = useRef(new Set<string>());
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  useEffect(() => {
    if (!visible || !sessionId || !alerts) return;
    const ids = alerts
      .filter((a) => !a.read && a.sessionId === sessionId && !sent.current.has(a.id))
      .map((a) => a.id);
    if (!ids.length) return;
    for (const id of ids) sent.current.add(id);
    void changeAlerts('read', ids);
  }, [alerts, sessionId, visible]);
}

const Launches = z.array(Launch);

/**
 * The person's new sessions of the last day, oldest first; with a PR, the ones reviewing it.
 * Refetched whenever one is asked for or changes. Off while `enabled` is false.
 */
export function useLaunches(pr?: { repo: string; number: number }, enabled = true): Launch[] {
  const [launches, setLaunches] = useState<Launch[]>([]);
  const repo = pr?.repo;
  const number = pr?.number;
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const query = repo && number ? `?${new URLSearchParams({ repo, number: String(number) })}` : '';
    const load = () =>
      apiFetch(`/api/launches${query}`)
        .then(async (r) => {
          if (r.ok && !cancelled) setLaunches(Launches.parse(await r.json()));
        })
        // Unreachable for now: the next launches event or reconnect snapshot loads them again.
        .catch(() => {});
    const unsubscribe = subscribe((event) => {
      if (event.type === 'launches' || event.type === 'snapshot') void load();
    });
    void load();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [repo, number, enabled]);
  return launches;
}

/** Asks for a new session. The launch, or why the server didn't take it. */
export async function startLaunch(request: LaunchRequest): Promise<Launch | { error: string }> {
  try {
    const res = await apiFetch('/api/launches', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    const body: unknown = await res.json().catch(() => ({}));
    if (res.ok) return Launch.parse(body);
    const error = (body as { error?: unknown }).error;
    return { error: typeof error === 'string' ? error : "JOC couldn't start the session." };
  } catch {
    return { error: "JOC couldn't reach the server. Try again." };
  }
}

/** The person's review instructions, once loaded. */
export function useReviewSettings(): ReviewSettings | undefined {
  const [settings, setSettings] = useState<ReviewSettings>();
  useEffect(() => {
    let cancelled = false;
    const fallback = () => {
      // Unreadable: Claude's standard review.
      if (!cancelled) setSettings({});
    };
    apiFetch('/api/settings/review')
      .then(async (r) => {
        if (cancelled) return;
        if (!r.ok) return fallback();
        setSettings(ReviewSettings.parse(await r.json()));
      })
      .catch(fallback);
    return () => {
      cancelled = true;
    };
  }, []);
  return settings;
}

const History = z.array(HistorySession);

/**
 * Past sessions, loaded when the page opens and again after a reconnect (the stream's snapshot),
 * but not on every update, so the list holds still while it's read.
 */
export function useHistory(enabled = true): HistorySession[] | undefined {
  const [history, setHistory] = useState<HistorySession[]>();
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = () =>
      apiFetch('/api/history')
        .then(async (r) => {
          if (r.ok && !cancelled) setHistory(History.parse(await r.json()));
        })
        // Unreachable for now: the reconnect snapshot loads it again.
        .catch(() => {});
    const unsubscribe = subscribe((event) => {
      if (event.type === 'snapshot') void load();
    });
    void load();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [enabled]);
  return history;
}

const Deletions = z.array(Deletion);

/** The person's deletes of the last day, oldest first, refetched whenever one changes. */
export function useDeletes(): Deletion[] {
  const [deletes, setDeletes] = useState<Deletion[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      apiFetch('/api/deletes')
        .then(async (r) => {
          if (r.ok && !cancelled) setDeletes(Deletions.parse(await r.json()));
        })
        // Unreachable for now: the next deletes event or reconnect snapshot loads them again.
        .catch(() => {});
    const unsubscribe = subscribe((event) => {
      if (event.type === 'deletes' || event.type === 'snapshot') void load();
    });
    void load();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  return deletes;
}

/** Asks for sessions to be deleted on their machines and in JOC. The deletes, or why not. */
export async function askDeletes(sessionIds: string[]): Promise<Deletion[] | { error: string }> {
  try {
    const res = await apiFetch('/api/deletes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionIds }),
    });
    const body: unknown = await res.json().catch(() => ({}));
    if (res.ok) return Deletions.parse(body);
    const refused = DeleteRefused.safeParse(body);
    if (!refused.success) return { error: "JOC couldn't delete them." };
    const [one] = refused.data.sessions ?? [];
    return { error: refused.data.sessions?.length === 1 && one ? one.reason : refused.data.error };
  } catch {
    return { error: "JOC couldn't reach the server. Try again." };
  }
}

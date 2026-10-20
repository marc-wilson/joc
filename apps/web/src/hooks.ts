import {
  type ConversationItem,
  type GitHubNotification,
  GitHubSnapshot,
  HistorySession,
  NotificationsSnapshot,
  Session,
  SessionSettings,
  type SessionState,
} from '@joc/protocol';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { freshThreads, newlyNeeding, seenNow, sessionAlert, threadAlert } from './alerts.ts';
import { apiFetch } from './auth.ts';
import { type DiffFile, parseDiff } from './diff.ts';
import { show } from './notify.ts';
import { subscribe } from './stream.ts';

const Sessions = z.array(Session);

/**
 * Live sessions, in first-seen order. `reload` reads the list afresh, for when the person changed
 * which sessions it keeps.
 */
export function useSessions(): { sessions: Session[]; connected: boolean; reload: () => void } {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(
    () =>
      subscribe((event) => {
        if (event.type === 'status') setConnected(event.connected);
        if (event.type === 'snapshot') setSessions(event.sessions);
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

  return { sessions, connected, reload };
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

/** A session's conversation: what the server has, plus live additions. */
export function useConversation(sessionId: string | undefined): ConversationItem[] {
  const [items, setItems] = useState<ConversationItem[]>([]);

  useEffect(() => {
    setItems([]);
    if (!sessionId) return;
    let cancelled = false;
    const load = () =>
      apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`)
        .then((r) => (r.ok ? (r.json() as Promise<ConversationItem[]>) : []))
        .then((loaded) => {
          if (!cancelled) setItems((list) => merge(list, loaded));
        })
        .catch(() => {});
    // Subscribe first so nothing that arrives during the fetch is lost; merge drops repeats.
    const unsubscribe = subscribe((event) => {
      if (event.type === 'messages' && event.sessionId === sessionId) {
        setItems((list) => merge(list, event.items));
      }
      // A reconnect may have missed messages.
      if (event.type === 'snapshot') void load();
    });
    void load();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [sessionId]);

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

/**
 * Raises browser notifications for news while the page is open (see alerts.ts). What's there
 * when the page loads is the starting point, never news, so a reload or another page never
 * repeats one.
 */
export function useBrowserAlerts(
  threads: GitHubNotification[] | undefined,
  sessions: Session[],
  connected: boolean,
) {
  const seen = useRef<Set<string>>(undefined);
  const states = useRef<Map<string, SessionState>>(undefined);

  useEffect(() => {
    if (!threads) return;
    if (!seen.current) {
      seen.current = seenNow(threads);
      return;
    }
    for (const t of freshThreads(seen.current, threads)) show(threadAlert(t));
  }, [threads]);

  useEffect(() => {
    // Before the stream's first snapshot the list is empty, not known.
    if (!connected) return;
    const before = states.current;
    states.current = new Map(sessions.map((s) => [s.id, s.state]));
    if (before) for (const s of newlyNeeding(before, sessions)) show(sessionAlert(s));
  }, [sessions, connected]);
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

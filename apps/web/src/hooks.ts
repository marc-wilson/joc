import {
  type Alert,
  type ConversationItem,
  DeleteRefused,
  Deletion,
  GitHubSnapshot,
  HistorySession,
  Launch,
  type LaunchRequest,
  Operations,
  type PromptStatus,
  type PullDiffMissing,
  Resume,
  ReviewSettings,
  Session,
  SessionChanges,
  SessionCommands,
  SessionPrompts,
  SessionSettings,
  SessionStatus,
  type SlashCommand,
} from '@joc/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { apiFetch } from './auth.ts';
import { type DiffFile, parseDiff, pullFile } from './diff.ts';
import { readAlerts } from './note-data.ts';
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

/**
 * A session's slash commands, as its plugin last sent them; undefined until it has (or while
 * they load), and refetched whenever it sends them again.
 */
export function useCommands(sessionId: string | undefined): SlashCommand[] | undefined {
  const [commands, setCommands] = useState<{ sessionId: string; list: SlashCommand[] }>();

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    const load = () =>
      apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/commands`)
        .then(async (r) => {
          if (cancelled || !r.ok) return;
          const body = SessionCommands.parse(await r.json());
          setCommands({ sessionId, list: body.commands });
        })
        .catch(() => {});
    const unsubscribe = subscribe((event) => {
      if (
        (event.type === 'commands' && event.sessionId === sessionId) ||
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

  // Another session's list never shows, not even for a moment after switching.
  return commands && commands.sessionId === sessionId ? commands.list : undefined;
}

/**
 * A session's status (version, model, MCP servers) as its plugin last sent it, while `open`:
 * undefined while it loads, null when the plugin hasn't sent one. Refetched when it sends again.
 */
export function useSessionStatus(
  sessionId: string | undefined,
  open: boolean,
): SessionStatus | null | undefined {
  const [status, setStatus] = useState<{ sessionId: string; status: SessionStatus | null }>();

  useEffect(() => {
    if (!sessionId || !open) return;
    let cancelled = false;
    const load = () =>
      apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/status`)
        .then(async (r) => {
          if (cancelled) return;
          if (r.status === 404) setStatus({ sessionId, status: null });
          else if (r.ok) setStatus({ sessionId, status: SessionStatus.parse(await r.json()) });
        })
        // Unreachable for now: the dialog keeps what it shows, and the next status event loads it.
        .catch(() => {});
    const unsubscribe = subscribe((event) => {
      if (
        (event.type === 'session-status' && event.sessionId === sessionId) ||
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
  }, [sessionId, open]);

  return status && status.sessionId === sessionId ? status.status : undefined;
}

/**
 * Where the session's prompts from the dashboard stand on the server (`PromptStatus`), kept
 * current as they move on. Undefined until the first answer.
 */
export function usePromptStatuses(sessionId: string | undefined): PromptStatus[] | undefined {
  const [statuses, setStatuses] = useState<{ sessionId: string; list: PromptStatus[] }>();

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    // Only the newest answer counts: an older one arriving late never rolls a prompt back.
    let asked = 0;
    const load = () => {
      const ask = ++asked;
      return (
        apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/prompts`)
          .then(async (r) => {
            if (cancelled || !r.ok) return;
            const body = SessionPrompts.parse(await r.json());
            if (ask === asked) setStatuses({ sessionId, list: body.prompts });
          })
          // Unreachable for now: the next prompts event or reconnect snapshot loads them again.
          .catch(() => {})
      );
    };
    const unsubscribe = subscribe((event) => {
      if (
        (event.type === 'prompts' && event.sessionId === sessionId) ||
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

  return statuses && statuses.sessionId === sessionId ? statuses.list : undefined;
}

/**
 * Keeps the toasts clear of the composer: `--toast-clear` on the root is the dock's height while
 * it's on the page, and the toast stack sits that much higher. Give it the dock.
 */
export function useToastClearance() {
  const observer = useRef<ResizeObserver>(undefined);
  const dock = useRef<HTMLElement>(undefined);
  useEffect(
    () => () => {
      observer.current?.disconnect();
      document.documentElement.style.removeProperty('--toast-clear');
    },
    [],
  );
  return useCallback((el: HTMLElement | null) => {
    if (el === (dock.current ?? null)) return;
    observer.current?.disconnect();
    dock.current = el ?? undefined;
    const root = document.documentElement.style;
    if (!el) {
      root.removeProperty('--toast-clear');
      return;
    }
    const fit = () => root.setProperty('--toast-clear', `${Math.round(el.offsetHeight)}px`);
    observer.current = new ResizeObserver(fit);
    observer.current.observe(el);
    fit();
  }, []);
}

/**
 * Caps the composer's command list (`--cmdlist-max` on the dock) at half the thread's height,
 * less a row, so the newest message stays at least half in view; never past 296px, 8 rows.
 * Give it the dock; the thread is the element before it.
 */
export function useCmdlistMax() {
  const observer = useRef<ResizeObserver>(undefined);
  return (dock: HTMLElement | null) => {
    observer.current?.disconnect();
    const thread = dock?.previousElementSibling;
    if (!dock || !thread) return;
    const fit = () => {
      const max = Math.min(296, Math.max(80, thread.clientHeight / 2 - 56));
      dock.style.setProperty('--cmdlist-max', `${Math.round(max)}px`);
    };
    observer.current = new ResizeObserver(fit);
    observer.current.observe(thread);
    fit();
  };
}

export type Changes =
  | { status: 'loading' }
  | { status: 'none' }
  | { status: 'unavailable'; repo: string; number: number; reason: PullDiffMissing }
  | {
      status: 'ready';
      base: string;
      files: DiffFile[];
      truncated: boolean;
      updatedAt: string;
      /** A review session's: the pull request the files are from, at its head commit. */
      pull?: { repo: string; number: number; headSha: string };
    };

/** What the Changes tab shows, from the server's answer. */
export function toChanges(body: SessionChanges): Changes {
  if (body.source === 'unavailable') return { status: 'unavailable', ...body };
  if (body.source === 'branch') {
    const { base, diff, truncated, updatedAt } = body;
    return { status: 'ready', base, truncated, updatedAt, files: parseDiff(diff) };
  }
  const { repo, number, headSha, base, files, truncated, updatedAt } = body;
  return {
    status: 'ready',
    base,
    truncated,
    updatedAt,
    files: files.map(pullFile),
    pull: { repo, number, headSha },
  };
}

/**
 * A session's latest diff, refetched whenever the plugin reports a new one; a review session's
 * also when GitHub news comes, as a push to the pull request moves its head.
 */
export function useChanges(sessionId: string | undefined, review = false): Changes {
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
          const body = SessionChanges.safeParse(await r.json());
          if (cancelled) return;
          setChanges(body.success ? toChanges(body.data) : { status: 'none' });
        })
        .catch(() => {});
    const unsubscribe = subscribe((event) => {
      if (
        (event.type === 'changes' && event.sessionId === sessionId) ||
        (review && event.type === 'github') ||
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
  }, [sessionId, review]);

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

/**
 * Marks the alerts about the session read while it's on screen: looking at it is reading them.
 * Each is sent once, and reads at once everywhere; if the server didn't take it, it's unread
 * again.
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
    readAlerts(ids);
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

const Resumes = z.array(Resume);
const Refused = z.object({ error: z.string() });

/** The person's resumes of the last day, oldest first, refetched whenever one changes. */
export function useResumes(): Resume[] {
  const [resumes, setResumes] = useState<Resume[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      apiFetch('/api/resumes')
        .then(async (r) => {
          if (r.ok && !cancelled) setResumes(Resumes.parse(await r.json()));
        })
        // Unreachable for now: the next resumes event or reconnect snapshot loads them again.
        .catch(() => {});
    const unsubscribe = subscribe((event) => {
      if (event.type === 'resumes' || event.type === 'snapshot') void load();
    });
    void load();
    // A waiting resume fails after a while without any event: look again now and then.
    const timer = setInterval(() => void load(), 60_000);
    return () => {
      cancelled = true;
      unsubscribe();
      clearInterval(timer);
    };
  }, []);
  return resumes;
}

/** Asks for an ended session to be resumed, on its machine or `machine`. The resume, or why not. */
export async function askResume(
  sessionId: string,
  machine?: string,
): Promise<Resume | { error: string }> {
  try {
    const res = await apiFetch('/api/resumes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, ...(machine ? { machine } : {}) }),
    });
    const body: unknown = await res.json().catch(() => ({}));
    if (res.ok) return Resume.parse(body);
    const refused = Refused.safeParse(body);
    return { error: refused.success ? refused.data.error : "JOC couldn't resume it." };
  } catch {
    return { error: "JOC couldn't reach the server. Try again." };
  }
}

/** Withdraws a resume no machine has taken yet. False when it already started. */
export async function withdrawResume(id: string): Promise<boolean> {
  const res = await apiFetch(`/api/resumes/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
  }).catch(() => undefined);
  return res?.ok ?? false;
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

/** How long a burst of live updates settles before Operations is read again. */
const OPERATIONS_SETTLE_MS = 400;

/**
 * The owner's Operations rows, read again shortly after any session or GitHub update, so its
 * cells change in place as the stream says things moved.
 */
export function useOperations(enabled = true): Operations | undefined {
  const [ops, setOps] = useState<Operations>();
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      apiFetch('/api/operations')
        .then(async (r) => {
          if (!r.ok || cancelled) return;
          const parsed = Operations.safeParse(await r.json());
          if (parsed.success && !cancelled) setOps(parsed.data);
        })
        // Unreachable for now: the next update or reconnect snapshot reads it again.
        .catch(() => {});
    const unsubscribe = subscribe((event) => {
      if (!['snapshot', 'session', 'github', 'deleted'].includes(event.type)) return;
      clearTimeout(timer);
      timer = setTimeout(() => void load(), OPERATIONS_SETTLE_MS);
    });
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [enabled]);
  return ops;
}

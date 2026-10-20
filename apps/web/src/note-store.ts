import type { Alert, GitHubNotification, NotificationsSnapshot } from '@joc/protocol';

// The one client-side store for JOC's alerts and the person's GitHub notifications. Every view
// of them (the bell, the panel's tabs, groups and rows, the toasts, the history, the tab's
// title) reads this, so counts and rows always agree. UI-free, so its races are tested in node.
//
// - An action shows at once; the server call follows; if the server says no, it rolls back and
//   says so in a quiet line.
// - What the server sends is applied in order, and an action waiting on the server is laid over
//   it, so a refetch or stream event never brings back a row you just read or cleared. Each
//   action's layer stays until the server's state is known to include it.
// - A GitHub thread is read on GitHub only once a machine's plugin gets to it. Here, the version
//   of the thread you read stays read (and keeps its row) until something newer happens on it.

export type NoteResource = 'alerts' | 'notifications';

/** How the store reaches the server and its stream; a fake one in tests. */
export interface NoteApi {
  alerts(): Promise<Alert[] | undefined>;
  notifications(): Promise<NotificationsSnapshot | undefined>;
  /** The list after the change, or undefined when the server didn't take it. */
  changeAlerts(action: 'read' | 'clear', ids: string[]): Promise<Alert[] | undefined>;
  /** The snapshot after the threads were queued to be marked read, or undefined. */
  readThreads(ids: string[]): Promise<NotificationsSnapshot | undefined>;
  /** Listens to the stream: which resource changed, or `undefined` for "everything" (a reconnect). */
  listen(onChange: (resource: NoteResource | undefined) => void): () => void;
}

export interface NoteData {
  /** Undefined until loaded. Read and cleared ones as done here. */
  alerts: Alert[] | undefined;
  snapshot: NotificationsSnapshot | undefined;
  /** The unread threads, and the ones read here, kept as read rows. */
  threads: GitHubNotification[];
  /** Ids of `threads` read here. */
  readThreads: ReadonlySet<string>;
  /** Why the last action didn't take, until the next one. */
  problem?: string;
}

interface AlertOp {
  action: 'read' | 'clear';
  ids: string[];
  /** When the server took it; its layer goes once a state at least this new is applied. */
  confirmed?: number;
}

const newer = (a: string, b: string) => Date.parse(a) > Date.parse(b);

export const PROBLEM = {
  read: 'Couldn’t mark read. Try again.',
  clear: 'Couldn’t clear. Try again.',
} as const;

export function createNoteStore(api: NoteApi) {
  // One clock orders every server state: a GET by when it started, an action's answer by when it
  // came back (it was computed after the change).
  let clock = 0;
  const applied: Record<NoteResource, number> = { alerts: 0, notifications: 0 };
  const loading: Record<NoteResource, boolean> = { alerts: false, notifications: false };
  const again: Record<NoteResource, boolean> = { alerts: false, notifications: false };
  const posting: Record<NoteResource, number> = { alerts: 0, notifications: 0 };

  let serverAlerts: Alert[] | undefined;
  let snapshot: NotificationsSnapshot | undefined;
  let ops: AlertOp[] = [];
  /** Thread id → the version (its `updatedAt`) read or cleared here. */
  const threadRead = new Map<string, string>();
  const threadCleared = new Map<string, string>();
  /** The copy of each thread read here, for its read row once the server stops listing it. */
  const kept = new Map<string, GitHubNotification>();
  let problem: string | undefined;

  const listeners = new Set<() => void>();
  let data = view();
  let stopListening: (() => void) | undefined;

  function view(): NoteData {
    const read = new Set<string>();
    const clear = new Set<string>();
    for (const op of ops) for (const id of op.ids) (op.action === 'read' ? read : clear).add(id);
    const alerts = serverAlerts
      ?.filter((a) => !clear.has(a.id))
      .map((a) => (!a.read && read.has(a.id) ? { ...a, read: true } : a));

    const listed = snapshot?.state === 'reported' ? snapshot.threads : [];
    const threads: GitHubNotification[] = [];
    const readThreads = new Set<string>();
    const cleared = (t: GitHubNotification) => {
      const v = threadCleared.get(t.id);
      return v !== undefined && !newer(t.updatedAt, v);
    };
    for (const t of listed) {
      if (cleared(t)) continue;
      threads.push(t);
      const v = threadRead.get(t.id);
      if (v !== undefined && !newer(t.updatedAt, v)) readThreads.add(t.id);
    }
    const present = new Set(listed.map((t) => t.id));
    for (const t of kept.values()) {
      if (present.has(t.id) || cleared(t)) continue;
      threads.push(t);
      readThreads.add(t.id);
    }
    return { alerts, snapshot, threads, readThreads, problem };
  }

  function changed() {
    data = view();
    for (const listener of listeners) listener();
  }

  /** Drops the layers of actions the server's state now includes. */
  function settle() {
    ops = ops.filter((op) => op.confirmed === undefined || op.confirmed > applied.alerts);
  }

  function applyAlerts(list: Alert[], at: number) {
    if (at <= applied.alerts) return;
    applied.alerts = at;
    serverAlerts = list;
    settle();
  }

  function applySnapshot(next: NotificationsSnapshot, at: number) {
    if (at <= applied.notifications) return;
    applied.notifications = at;
    snapshot = next;
    // Something newer happened on a thread read or cleared here: it's news again.
    for (const t of next.state === 'reported' ? next.threads : []) {
      const read = threadRead.get(t.id);
      if (read !== undefined && newer(t.updatedAt, read)) {
        threadRead.delete(t.id);
        kept.delete(t.id);
      }
      const gone = threadCleared.get(t.id);
      if (gone !== undefined && newer(t.updatedAt, gone)) threadCleared.delete(t.id);
    }
  }

  /** Reads one resource afresh. One read at a time each; a call meanwhile reads once more after. */
  function load(resource: NoteResource): void {
    if (loading[resource]) {
      again[resource] = true;
      return;
    }
    loading[resource] = true;
    const at = ++clock;
    const done = (ok: boolean) => {
      loading[resource] = false;
      if (ok) changed();
      if (again[resource]) {
        again[resource] = false;
        load(resource);
      }
    };
    if (resource === 'alerts') {
      api
        .alerts()
        .then((list) => {
          if (list) applyAlerts(list, at);
          done(list !== undefined);
        })
        .catch(() => done(false));
    } else {
      api
        .notifications()
        .then((next) => {
          if (next) applySnapshot(next, at);
          done(next !== undefined);
        })
        .catch(() => done(false));
    }
  }

  /**
   * An action's answer: the server's state just after it. Applied only when nothing else for the
   * resource is on its way (an older answer or read could land after and win); otherwise a fresh
   * read follows the rest.
   */
  function answered<T>(resource: NoteResource, state: T, apply: (state: T, at: number) => void) {
    const at = ++clock;
    if (loading[resource] || posting[resource] > 0) load(resource);
    else apply(state, at);
    return at;
  }

  async function changeAlerts(action: 'read' | 'clear', ids: string[]): Promise<boolean> {
    const op: AlertOp = { action, ids };
    ops = [...ops, op];
    posting.alerts++;
    changed();
    const list = await api.changeAlerts(action, ids).catch(() => undefined);
    posting.alerts--;
    if (list) {
      op.confirmed = answered('alerts', list, applyAlerts);
      settle();
      changed();
    } else {
      // Rolled back; what the server has now is read again, in case it took part of it.
      ops = ops.filter((o) => o !== op);
      load('alerts');
    }
    return list !== undefined;
  }

  async function readThreads(ids: string[]): Promise<boolean> {
    posting.notifications++;
    const next = await api.readThreads(ids).catch(() => undefined);
    posting.notifications--;
    if (next) {
      answered('notifications', next, applySnapshot);
      changed();
    } else load('notifications');
    return next !== undefined;
  }

  /** The current copy of each thread, by id, as shown. */
  const threadsById = () => new Map(data.threads.map((t) => [t.id, t]));

  function start() {
    problem = undefined;
  }

  function fail(what: keyof typeof PROBLEM) {
    problem = PROBLEM[what];
    changed();
  }

  return {
    get: (): NoteData => data,

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (!stopListening) {
        stopListening = api.listen((resource) => {
          if (resource !== 'notifications') load('alerts');
          if (resource !== 'alerts') load('notifications');
        });
        load('alerts');
        load('notifications');
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          stopListening?.();
          stopListening = undefined;
        }
      };
    },

    load,

    /**
     * Marks these alerts and threads read. Resolves once the server answered. `quiet` for a read
     * the person didn't ask for (looking at a session): a failure isn't theirs to hear about.
     */
    async markRead(alertIds: string[], threadIds: string[], quiet = false): Promise<boolean> {
      if (!quiet) start();
      const byId = threadsById();
      const threads = [...new Set(threadIds)].flatMap((id) => {
        const t = byId.get(id);
        return t && !data.readThreads.has(id) ? [t] : [];
      });
      for (const t of threads) {
        threadRead.set(t.id, t.updatedAt);
        kept.set(t.id, t);
      }
      const alerts = alertIds.length ? changeAlerts('read', alertIds) : true;
      if (threads.length) changed();
      const [a, t] = await Promise.all([
        alerts,
        threads.length ? readThreads(threads.map((x) => x.id)) : true,
      ]);
      if (!t) {
        // Back to unread, unless something else changed it meanwhile.
        for (const x of threads) {
          if (threadRead.get(x.id) === x.updatedAt) {
            threadRead.delete(x.id);
            kept.delete(x.id);
          }
        }
      }
      if ((!a || !t) && !quiet) fail('read');
      return a && t;
    },

    /**
     * Clears these alerts for good. A GitHub thread can't be deleted: clearing one marks it read
     * there (if it isn't already) and leaves it out here.
     */
    async clear(alertIds: string[], threadIds: string[]): Promise<boolean> {
      start();
      const byId = threadsById();
      const threads = [...new Set(threadIds)].flatMap((id) => byId.get(id) ?? []);
      const unread = threads.filter((t) => !data.readThreads.has(t.id));
      for (const t of threads) threadCleared.set(t.id, t.updatedAt);
      const alerts = alertIds.length ? changeAlerts('clear', alertIds) : true;
      if (threads.length) changed();
      const [a, t] = await Promise.all([
        alerts,
        unread.length ? readThreads(unread.map((x) => x.id)) : true,
      ]);
      if (!t) {
        for (const x of unread) {
          if (threadCleared.get(x.id) === x.updatedAt) threadCleared.delete(x.id);
        }
      }
      if (!a || !t) fail('clear');
      return a && t;
    },
  };
}

export type NoteStore = ReturnType<typeof createNoteStore>;

import type { Alert } from '@joc/protocol';

// The one client-side store for JOC's alerts: sessions, and GitHub's review requests, failed CI,
// mentions and comments, as the server raised them. Every view of them (the bell, the panel's
// tabs, groups and rows, the toasts, the history, the tab's title) reads this, so counts and rows
// always agree. UI-free, so its races are tested in node.
//
// - An action shows at once; the server call follows; if the server says no, it rolls back and
//   says so in a quiet line.
// - What the server sends is applied in order, and an action waiting on the server is laid over
//   it, so a refetch or stream event never brings back a row you just read or cleared. Each
//   action's layer stays until the server's state is known to include it.

export type NoteResource = 'alerts';

/** How the store reaches the server and its stream; a fake one in tests. */
export interface NoteApi {
  alerts(): Promise<Alert[] | undefined>;
  /** The list after the change, or undefined when the server didn't take it. */
  changeAlerts(action: 'read' | 'clear', ids: string[]): Promise<Alert[] | undefined>;
  /** Listens to the stream: which resource changed, or `undefined` for "everything" (a reconnect). */
  listen(onChange: (resource: NoteResource | undefined) => void): () => void;
}

export interface NoteData {
  /** Undefined until loaded. Read and cleared ones as done here. */
  alerts: Alert[] | undefined;
  /** Why the last action didn't take, until the next one. */
  problem?: string;
}

interface AlertOp {
  action: 'read' | 'clear';
  ids: string[];
  /** When the server took it; its layer goes once a state at least this new is applied. */
  confirmed?: number;
}

export const PROBLEM = {
  read: 'Couldn’t dismiss. Try again.',
  clear: 'Couldn’t clear. Try again.',
} as const;

export function createNoteStore(api: NoteApi) {
  // One clock orders every server state: a GET by when it started, an action's answer by when it
  // came back (it was computed after the change).
  let clock = 0;
  const applied: Record<NoteResource, number> = { alerts: 0 };
  const loading: Record<NoteResource, boolean> = { alerts: false };
  const again: Record<NoteResource, boolean> = { alerts: false };
  const posting: Record<NoteResource, number> = { alerts: 0 };

  let serverAlerts: Alert[] | undefined;
  let ops: AlertOp[] = [];
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

    return { alerts, problem };
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
    api
      .alerts()
      .then((list) => {
        if (list) applyAlerts(list, at);
        done(list !== undefined);
      })
      .catch(() => done(false));
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
        stopListening = api.listen(() => load('alerts'));
        load('alerts');
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
     * Marks these alerts read. Resolves once the server answered. `quiet` for a read the person
     * didn't ask for (looking at a session): a failure isn't theirs to hear about.
     */
    async markRead(alertIds: string[], quiet = false): Promise<boolean> {
      if (!quiet) start();
      if (!alertIds.length) return true;
      const ok = await changeAlerts('read', alertIds);
      if (!ok && !quiet) fail('read');
      return ok;
    },

    /** Clears these alerts for good. */
    async clear(alertIds: string[]): Promise<boolean> {
      start();
      if (!alertIds.length) return true;
      const ok = await changeAlerts('clear', alertIds);
      if (!ok) fail('clear');
      return ok;
    },
  };
}

export type NoteStore = ReturnType<typeof createNoteStore>;

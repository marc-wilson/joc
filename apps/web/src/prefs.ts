import {
  applyPrefsPatch,
  combinePrefsPatches,
  DEFAULT_PREFS,
  Prefs,
  type PrefsPatch,
  PrefsSnapshot,
  type SessionPrefs,
  type SessionPrefsPatch,
} from '@joc/protocol';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { apiFetch } from './auth.ts';
import { legacyKeys, legacyPatch } from './legacy-prefs.ts';
import { subscribe } from './stream.ts';

// The person's preferences, kept on the server so they follow them to every browser. Read once
// at startup; a change shows at once and is written a moment later; other tabs hear it on the
// stream.

let prefs: Prefs = DEFAULT_PREFS;
let loading: Promise<void> | undefined;
const listeners = new Set<() => void>();

/** Changes not yet sent, and how many writes are on their way. */
let pending: PrefsPatch | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let writing = 0;

const WRITE_AFTER_MS = 400;
const RETRY_AFTER_MS = 5_000;
/** Past this, the page shows with the defaults rather than wait on a slow server. */
const LOAD_WAIT_MS = 2_000;

function set(next: Prefs) {
  prefs = next;
  for (const listener of listeners) listener();
}

/** The server's prefs, unless a change made here is still on its way there. */
function take(next: Prefs) {
  if (!pending && !writing) set(next);
}

type Written = 'ok' | 'refused' | 'unreachable';

async function write(patch: PrefsPatch, keepalive = false): Promise<Written> {
  writing++;
  let stored: Prefs | undefined;
  try {
    const res = await apiFetch('/api/prefs', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
      keepalive,
    });
    if (res.status >= 400 && res.status < 500) return 'refused';
    if (!res.ok) return 'unreachable';
    const parsed = Prefs.safeParse(await res.json().catch(() => undefined));
    stored = parsed.success ? parsed.data : undefined;
    return 'ok';
  } catch {
    return 'unreachable';
  } finally {
    writing--;
    if (stored) take(stored);
  }
}

function flush(keepalive = false) {
  clearTimeout(timer);
  timer = undefined;
  const patch = pending;
  pending = undefined;
  if (!patch) return;
  void write(patch, keepalive).then((result) => {
    if (result !== 'unreachable') return;
    // Kept, and sent again shortly; the change stays shown here meanwhile.
    pending = pending ? combinePrefsPatches(patch, pending) : patch;
    timer ??= setTimeout(flush, RETRY_AFTER_MS);
  });
}

/** Changes the prefs here at once, and on the server shortly after. */
export function updatePrefs(patch: PrefsPatch) {
  set(applyPrefsPatch(prefs, patch, Date.now()));
  pending = pending ? combinePrefsPatches(pending, patch) : patch;
  clearTimeout(timer);
  timer = setTimeout(flush, WRITE_AFTER_MS);
}

/** Changes one session's folds or viewed files. */
export function updateSessionPrefs(change: SessionPrefsPatch) {
  updatePrefs({ sessions: [change] });
}

async function fetchPrefs(): Promise<PrefsSnapshot | undefined> {
  const res = await apiFetch('/api/prefs').catch(() => undefined);
  const parsed = PrefsSnapshot.safeParse(await res?.json().catch(() => undefined));
  return parsed.success ? parsed.data : undefined;
}

/** Reads the prefs once; resolves when they're in, or after a short wait with the defaults. */
export function loadPrefs(): Promise<void> {
  loading ??= new Promise<void>((resolve) => {
    // A change made just before the tab closes still goes out.
    window.addEventListener('pagehide', () => flush(true));
    const waited = setTimeout(resolve, LOAD_WAIT_MS);
    void fetchPrefs().then(async (snapshot) => {
      if (snapshot) {
        take(snapshot.prefs);
        if (!snapshot.saved) await migrate();
      }
      clearTimeout(waited);
      resolve();
    });
  });
  return loading;
}

/** Whether the first read finished (or gave up waiting). */
export function usePrefsLoaded(): boolean {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    void loadPrefs().then(() => live && setLoaded(true));
    return () => {
      live = false;
    };
  }, []);
  return loaded;
}

/** Keeps the prefs current while mounted: changes from other tabs, and after a reconnect. */
export function usePrefsSync() {
  useEffect(() => {
    let first = true;
    return subscribe((event) => {
      if (event.type === 'prefs') take(event.prefs);
      if (event.type === 'snapshot') {
        // A reconnect may have missed a change.
        if (!first) void fetchPrefs().then((s) => s && take(s.prefs));
        first = false;
      }
    });
  }, []);
}

const onChange = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The current prefs, outside React. */
export const currentPrefs = () => prefs;

export function usePrefs(): Prefs {
  return useSyncExternalStore(onChange, currentPrefs);
}

const NO_SESSION_PREFS: Omit<SessionPrefs, 'id' | 'at'> = {
  foldedMessages: [],
  viewedFiles: [],
  foldedFiles: [],
  openedFiles: [],
};

/** What the person folded and viewed in one session. */
export function useSessionPrefs(id: string): Omit<SessionPrefs, 'id' | 'at'> {
  return usePrefs().sessions.find((s) => s.id === id) ?? NO_SESSION_PREFS;
}

/**
 * Once, for a server with no prefs yet: sends what an older dashboard kept in this browser, then
 * forgets it here. Storage blocked or empty: nothing to move.
 */
async function migrate() {
  let keys: string[];
  try {
    keys = legacyKeys(Object.keys(localStorage));
  } catch {
    return;
  }
  if (!keys.length) return;
  const patch = legacyPatch((key) => localStorage.getItem(key), keys);
  if (Object.keys(patch).length) {
    set(applyPrefsPatch(prefs, patch, Date.now()));
    // Not taken this time: the next load tries again.
    if ((await write(patch)) === 'unreachable') return;
  }
  try {
    for (const key of keys) localStorage.removeItem(key);
  } catch {}
}

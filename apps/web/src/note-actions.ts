import { useSyncExternalStore } from 'react';
import { apiFetch } from './auth.ts';
import { changeAlerts } from './hooks.ts';
import type { Note } from './notes.ts';

// Marking notes read and clearing them, shared by the panel, the toasts and the history. Each
// shows at once and comes back if the server didn't take it. A GitHub thread marked read leaves
// the server's unread list; it's kept here, read, until the page reloads, so it doesn't vanish
// from under the pointer.

const readHere = new Set<string>();
const clearedHere = new Set<string>();
const kept = new Map<string, Note>();
let version = 0;
const listeners = new Set<() => void>();

function changed() {
  version++;
  for (const listener of listeners) listener();
}

const onChange = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Re-renders when a note is marked read or cleared here. */
export const useNoteChanges = () => useSyncExternalStore(onChange, () => version);

/** The notes with what was done here applied: read ones read, cleared ones gone. */
export function applyLocal(notes: Note[]): Note[] {
  const present = new Set(notes.map((n) => n.id));
  const shown = notes
    .filter((n) => !clearedHere.has(n.id))
    .map((n) => (readHere.has(n.id) && !n.live ? { ...n, unread: false } : n));
  const left = [...kept.values()].filter((n) => !present.has(n.id) && !clearedHere.has(n.id));
  return [...shown, ...left];
}

async function postThreads(ids: string[]): Promise<boolean> {
  if (!ids.length) return true;
  const res = await apiFetch('/api/notifications/read', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids }),
  }).catch(() => undefined); // Unreachable: reported as not done.
  return res?.ok === true;
}

const alertIds = (notes: Note[]) => notes.flatMap((n) => (n.alertId ? [n.alertId] : []));
const threadIds = (notes: Note[]) => notes.flatMap((n) => n.threadIds);

/** Marks the notes read: their alerts here, their threads on GitHub. */
export async function markRead(notes: Note[]): Promise<void> {
  const list = notes.filter((n) => !n.live && n.unread);
  if (!list.length) return;
  for (const n of list) {
    readHere.add(n.id);
    if (n.threadIds.length) kept.set(n.id, { ...n, unread: false });
  }
  changed();
  const alerts = alertIds(list);
  const [a, t] = await Promise.all([
    alerts.length ? changeAlerts('read', alerts) : true,
    postThreads(threadIds(list)),
  ]);
  if (a && t) return;
  for (const n of list) {
    readHere.delete(n.id);
    kept.delete(n.id);
  }
  changed();
}

/**
 * Clears the notes: their alerts leave for good. A GitHub thread can't be deleted, so clearing
 * one marks it read and leaves it out here.
 */
export async function clearNotes(notes: Note[]): Promise<void> {
  const list = notes.filter((n) => !n.live);
  if (!list.length) return;
  for (const n of list) clearedHere.add(n.id);
  changed();
  const alerts = alertIds(list);
  const [a, t] = await Promise.all([
    alerts.length ? changeAlerts('clear', alerts) : true,
    postThreads(threadIds(list.filter((n) => n.unread))),
  ]);
  if (a && t) return;
  for (const n of list) clearedHere.delete(n.id);
  changed();
}

import { Alert, NotificationsSnapshot } from '@joc/protocol';
import { useSyncExternalStore } from 'react';
import { z } from 'zod';
import { apiFetch } from './auth.ts';
import { createNoteStore, type NoteData } from './note-store.ts';
import type { Note } from './notes.ts';
import { subscribe } from './stream.ts';

// The app's one note store (note-store.ts), on the real server and its stream, and the actions
// every view of the notes shares: the panel, the toasts, the history and the session page.

const Alerts = z.array(Alert);

/** The body, if the server answered with one that parses; undefined otherwise. */
async function call<T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<T | undefined> {
  try {
    const res = await apiFetch(
      path,
      body === undefined
        ? undefined
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
    );
    if (!res.ok) return undefined;
    const parsed = schema.safeParse(await res.json());
    return parsed.success ? parsed.data : undefined;
  } catch {
    // Unreachable: reported as not done.
    return undefined;
  }
}

export const noteStore = createNoteStore({
  alerts: () => call('/api/alerts', Alerts),
  notifications: () => call('/api/notifications', NotificationsSnapshot),
  changeAlerts: (action, ids) => call(`/api/alerts/${action}`, Alerts, { ids }),
  readThreads: (ids) => call('/api/notifications/read', NotificationsSnapshot, { ids }),
  listen: (onChange) =>
    subscribe((event) => {
      if (event.type === 'alerts') onChange('alerts');
      if (event.type === 'notifications') onChange('notifications');
      // A reconnect may have missed either.
      if (event.type === 'snapshot') onChange(undefined);
    }),
});

/** The alerts and GitHub notifications, as every view shows them. */
export const useNoteData = (): NoteData => useSyncExternalStore(noteStore.subscribe, noteStore.get);

const alertIds = (notes: Note[]) => notes.flatMap((n) => (n.alertId ? [n.alertId] : []));
const threadIds = (notes: Note[]) => notes.flatMap((n) => n.threadIds);

/** Marks the notes read: their alerts here, their threads on GitHub. Shows at once. */
export function markRead(notes: Note[]): void {
  const list = notes.filter((n) => !n.live && n.unread);
  if (list.length) void noteStore.markRead(alertIds(list), threadIds(list));
}

/** Clears the notes. Their rows leave at once. */
export function clearNotes(notes: Note[]): void {
  const list = notes.filter((n) => !n.live);
  if (list.length) void noteStore.clear(alertIds(list), threadIds(list));
}

/** Marks these alerts read, as looking at their session does. */
export function readAlerts(ids: string[]): void {
  if (ids.length) void noteStore.markRead(ids, [], true);
}

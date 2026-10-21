import { Alert, NotificationsSnapshot } from '@joc/protocol';
import { type MouseEvent, useSyncExternalStore } from 'react';
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
            // Opening a note can leave the page: the read still goes out.
            keepalive: true,
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

/**
 * Dismisses the notes, as opening them does: their alerts read here, their threads on GitHub.
 * They leave the panel in the same frame; the server hears after. A session waiting on you
 * isn't dismissed: it goes when it's answered.
 */
export function dismiss(notes: Note[]): void {
  const list = notes.filter((n) => !n.live && n.unread);
  if (list.length) void noteStore.markRead(alertIds(list), threadIds(list));
}

/** Marks these alerts read, as looking at their session does. */
export function readAlerts(ids: string[]): void {
  if (ids.length) void noteStore.markRead(ids, [], true);
}

/** The event App follows to open a session without a page load. */
export const OPEN_SESSION = 'popstate';

/**
 * Opening a note reads it. A session on the dashboard you're on opens in place, with no page
 * load: true when that's done (and the click's own navigation prevented). Otherwise the link
 * goes where it points.
 */
export function openNote(note: Note, e?: MouseEvent): boolean {
  dismiss([note]);
  if (e && (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)) return false;
  if (note.external || !note.href.startsWith('/?session=') || location.pathname !== '/') {
    return false;
  }
  e?.preventDefault();
  history.pushState(null, '', note.href);
  window.dispatchEvent(new PopStateEvent(OPEN_SESSION));
  return true;
}

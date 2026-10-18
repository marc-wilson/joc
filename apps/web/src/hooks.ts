import type { ConversationItem, Session } from '@joc/protocol';
import { useEffect, useState } from 'react';
import { subscribe } from './stream.ts';

/** Live sessions, in first-seen order. */
export function useSessions(): { sessions: Session[]; connected: boolean } {
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

  return { sessions, connected };
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
      fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`)
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

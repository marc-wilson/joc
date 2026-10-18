import { Session } from '@joc/protocol';
import { useEffect, useState } from 'react';
import { z } from 'zod';

const Snapshot = z.object({ type: z.literal('snapshot'), sessions: z.array(Session) });
const Update = z.object({ type: z.literal('session'), session: Session });

/** Live sessions from the server's event stream, in first-seen order. */
export function useSessions(): { sessions: Session[]; connected: boolean } {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    // EventSource reconnects on its own, and each reconnect starts with a fresh snapshot.
    const source = new EventSource('/api/stream');
    source.addEventListener('snapshot', (e) => {
      setSessions(Snapshot.parse(JSON.parse(e.data)).sessions);
      setConnected(true);
    });
    source.addEventListener('session', (e) => {
      const { session } = Update.parse(JSON.parse(e.data));
      // Update in place so rows never move; new sessions go at the end.
      setSessions((list) =>
        list.some((s) => s.id === session.id)
          ? list.map((s) => (s.id === session.id ? session : s))
          : [...list, session],
      );
    });
    source.onerror = () => setConnected(false);
    return () => source.close();
  }, []);

  return { sessions, connected };
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

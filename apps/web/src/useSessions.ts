import { Session } from '@joc/protocol';
import { useEffect, useState } from 'react';
import { z } from 'zod';

const Snapshot = z.object({ type: z.literal('snapshot'), sessions: z.array(Session) });
const Update = z.object({ type: z.literal('session'), session: Session });

// The server pings every 15s. A proxy can keep a connection open after the server behind it
// went away, so this much silence means the stream is dead.
const STREAM_TIMEOUT_MS = 40_000;

/** Live sessions from the server's event stream, in first-seen order. */
export function useSessions(): { sessions: Session[]; connected: boolean } {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let source: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let lastMessage = Date.now();
    const alive = () => {
      lastMessage = Date.now();
    };

    // Each (re)connect starts with a fresh snapshot, so nothing is missed while disconnected.
    function connect() {
      lastMessage = Date.now();
      source = new EventSource('/api/stream');
      source.addEventListener('ping', alive);
      source.addEventListener('snapshot', (e) => {
        alive();
        setSessions(Snapshot.parse(JSON.parse(e.data)).sessions);
        setConnected(true);
      });
      source.addEventListener('session', (e) => {
        alive();
        const { session } = Update.parse(JSON.parse(e.data));
        // Update in place so rows never move; new sessions go at the end.
        setSessions((list) =>
          list.some((s) => s.id === session.id)
            ? list.map((s) => (s.id === session.id ? session : s))
            : [...list, session],
        );
      });
      source.onerror = () => {
        setConnected(false);
        // EventSource retries dropped connections itself, but gives up for good when a retry
        // gets an error response (the server restarting, a deploy). Start over in that case.
        if (source?.readyState === EventSource.CLOSED) retry = setTimeout(connect, 2000);
      };
    }

    connect();
    const watchdog = setInterval(() => {
      if (Date.now() - lastMessage < STREAM_TIMEOUT_MS) return;
      setConnected(false);
      source?.close();
      clearTimeout(retry);
      connect();
    }, 5_000);
    return () => {
      clearInterval(watchdog);
      clearTimeout(retry);
      source?.close();
    };
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

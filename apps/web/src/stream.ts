import { ConversationItem, Session } from '@joc/protocol';
import { z } from 'zod';

// One connection to the server's event stream for the whole app, shared by every hook.

const Snapshot = z.object({ type: z.literal('snapshot'), sessions: z.array(Session) });
const Update = z.object({ type: z.literal('session'), session: Session });
const Messages = z.object({
  type: z.literal('messages'),
  sessionId: z.string(),
  items: z.array(ConversationItem),
});

export type LiveEvent =
  | z.infer<typeof Snapshot>
  | z.infer<typeof Update>
  | z.infer<typeof Messages>
  | { type: 'status'; connected: boolean };

// The server pings every 15s. A proxy can keep a connection open after the server behind it
// went away, so this much silence means the stream is dead.
const STREAM_TIMEOUT_MS = 40_000;

const listeners = new Set<(event: LiveEvent) => void>();
let started = false;

const emit = (event: LiveEvent) => {
  for (const listener of listeners) listener(event);
};

function start() {
  let source: EventSource | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let lastMessage = Date.now();

  // Each (re)connect starts with a fresh snapshot, so nothing is missed while disconnected.
  function connect() {
    lastMessage = Date.now();
    source = new EventSource('/api/stream');
    const on = <T extends LiveEvent>(type: string, schema: z.ZodType<T>) =>
      source?.addEventListener(type, (e) => {
        lastMessage = Date.now();
        emit(schema.parse(JSON.parse((e as MessageEvent<string>).data)));
        if (type === 'snapshot') emit({ type: 'status', connected: true });
      });
    on('snapshot', Snapshot);
    on('session', Update);
    on('messages', Messages);
    source.addEventListener('ping', () => {
      lastMessage = Date.now();
    });
    source.onerror = () => {
      emit({ type: 'status', connected: false });
      // EventSource retries dropped connections itself, but gives up for good when a retry
      // gets an error response (the server restarting, a deploy). Start over in that case.
      if (source?.readyState === EventSource.CLOSED) retry = setTimeout(connect, 2000);
    };
  }

  connect();
  setInterval(() => {
    if (Date.now() - lastMessage < STREAM_TIMEOUT_MS) return;
    emit({ type: 'status', connected: false });
    source?.close();
    clearTimeout(retry);
    connect();
  }, 5_000);
}

export function subscribe(listener: (event: LiveEvent) => void): () => void {
  listeners.add(listener);
  if (!started) {
    started = true;
    start();
  }
  return () => listeners.delete(listener);
}

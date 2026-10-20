import { ConversationItem, Prefs, Session } from '@joc/protocol';
import { z } from 'zod';
import { checkAuth } from './auth.ts';

// One connection to the server's event stream for the whole app, shared by every hook.

const Snapshot = z.object({ type: z.literal('snapshot'), sessions: z.array(Session) });
const Update = z.object({ type: z.literal('session'), session: Session });
const ChangesEvent = z.object({ type: z.literal('changes'), sessionId: z.string() });
const CommandsEvent = z.object({ type: z.literal('commands'), sessionId: z.string() });
const GitHubEvent = z.object({ type: z.literal('github') });
const NotificationsEvent = z.object({ type: z.literal('notifications') });
const AlertsEvent = z.object({ type: z.literal('alerts') });
const LaunchesEvent = z.object({ type: z.literal('launches') });
const DeletesEvent = z.object({ type: z.literal('deletes') });
const DeletedEvent = z.object({ type: z.literal('deleted'), sessionId: z.string() });
const ResumesEvent = z.object({ type: z.literal('resumes') });
const PrefsEvent = z.object({ type: z.literal('prefs'), prefs: Prefs });
const Messages = z.object({
  type: z.literal('messages'),
  sessionId: z.string(),
  items: z.array(ConversationItem),
});

export type LiveEvent =
  | z.infer<typeof Snapshot>
  | z.infer<typeof Update>
  | z.infer<typeof Messages>
  | z.infer<typeof ChangesEvent>
  | z.infer<typeof CommandsEvent>
  | z.infer<typeof GitHubEvent>
  | z.infer<typeof NotificationsEvent>
  | z.infer<typeof AlertsEvent>
  | z.infer<typeof LaunchesEvent>
  | z.infer<typeof DeletesEvent>
  | z.infer<typeof DeletedEvent>
  | z.infer<typeof ResumesEvent>
  | z.infer<typeof PrefsEvent>
  | { type: 'status'; connected: boolean };

// The server pings every 15s. A proxy can keep a connection open after the server behind it
// went away, so this much silence means the stream is dead.
const STREAM_TIMEOUT_MS = 40_000;

const listeners = new Set<(event: LiveEvent) => void>();
let stop: (() => void) | undefined;

const emit = (event: LiveEvent) => {
  for (const listener of listeners) listener(event);
};

function start(): () => void {
  let source: EventSource | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let lastMessage = Date.now();
  let stopped = false;

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
    on('changes', ChangesEvent);
    on('commands', CommandsEvent);
    on('github', GitHubEvent);
    on('notifications', NotificationsEvent);
    on('alerts', AlertsEvent);
    on('launches', LaunchesEvent);
    on('deletes', DeletesEvent);
    on('deleted', DeletedEvent);
    on('resumes', ResumesEvent);
    on('prefs', PrefsEvent);
    source.addEventListener('ping', () => {
      lastMessage = Date.now();
    });
    source.onerror = () => {
      emit({ type: 'status', connected: false });
      // EventSource retries dropped connections itself, but gives up for good when a retry
      // gets an error response (the server restarting, a deploy, a 401). Start over in that
      // case, unless the server no longer takes our cookie: then the sign-in screen takes over.
      if (source?.readyState !== EventSource.CLOSED) return;
      retry = setTimeout(async () => {
        if ((await checkAuth()).status === 'signedIn' && !stopped) connect();
      }, 2000);
    };
  }

  connect();
  const watchdog = setInterval(() => {
    if (Date.now() - lastMessage < STREAM_TIMEOUT_MS) return;
    emit({ type: 'status', connected: false });
    source?.close();
    clearTimeout(retry);
    connect();
  }, 5_000);
  return () => {
    stopped = true;
    clearInterval(watchdog);
    clearTimeout(retry);
    source?.close();
  };
}

export function subscribe(listener: (event: LiveEvent) => void): () => void {
  listeners.add(listener);
  stop ??= start();
  return () => {
    listeners.delete(listener);
    // Nobody listening (signed out): close the connection; the next subscriber reopens it.
    if (listeners.size === 0) {
      stop?.();
      stop = undefined;
    }
  };
}

import {
  channelsOf,
  type NotificationsSnapshot,
  NotificationTab,
  type Session,
} from '@joc/protocol';
import {
  ArrivalsPill,
  EmptyState,
  type NotificationBellProps,
  NotificationGroup,
  NotificationPanel,
  NotificationRow,
  Toast,
  ToastStack,
} from '@joc/ui';
import { type MouseEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { NoteAnswers } from './Answering.tsx';
import { droppedAnswers, useSent } from './answers.ts';
import { useGitHub, useNow, useSessions } from './hooks.ts';
import { NotificationSettingsDialog } from './NotificationSettings.tsx';
import { dismiss, openNote, useNoteData } from './note-data.ts';
import {
  allNotes,
  arrived,
  attention,
  bellCounts,
  clearable,
  GROUP_LABEL,
  groupNotes,
  type Held,
  hold,
  inTab,
  type Note,
  pageTitle,
  panelNotes,
  withLeaving,
} from './notes.ts';
import { supported } from './notify.ts';
import { currentPrefs, updatePrefs, usePrefs } from './prefs.ts';
import { chime } from './sound.ts';
import { age, ago } from './time.ts';

// The notification center: the bell's panel over the page, the toasts, the chime, desktop
// notifications and the tab's title. Sessions waiting on you come first everywhere and stay
// until they stop waiting. Every action shows in the same frame; the server hears after.

const PANEL_ID = 'joc-notifications';
const MAX_TOASTS = 3;
/** = --duration-fast: how long a leaving row takes to fade out before it goes. */
const LEAVE_MS = 140;

/**
 * Every note, from the one note store (note-data.ts) with what was done here applied, and
 * whether all their sources have loaded. Every view builds its notes here, so they agree.
 */
export function useNotes(records = false): {
  notes: Note[];
  loaded: boolean;
  sessions: Session[];
  connected: boolean;
  snapshot: NotificationsSnapshot | undefined;
  /** Why the last dismiss didn't take, until the next one. */
  problem?: string;
} {
  const { sessions, connected } = useSessions();
  const github = useGitHub();
  const { alerts, snapshot, threads, readThreads, problem } = useNoteData();
  const notes = useMemo(
    () => allNotes({ sessions, alerts: alerts ?? [], threads, read: readThreads, github, records }),
    [sessions, alerts, threads, readThreads, github, records],
  );
  return {
    notes,
    loaded: connected && alerts !== undefined && snapshot !== undefined,
    sessions,
    connected,
    snapshot,
    problem,
  };
}

const mono = (note: Note): ReactNode =>
  note.mono && note.text ? <code>{note.text}</code> : note.text;

interface NoteRowProps {
  note: Note;
  now: number;
  sessions: Session[];
  /** The history's clock time instead of an age. */
  time?: string;
  leaving?: boolean;
}

/** One note's row: opening it reads it; the ✕ dismisses it. */
export function NoteRow({ note, now, sessions, time, leaving }: NoteRowProps) {
  return (
    <NotificationRow
      lead={note.lead}
      title={note.title}
      source={note.source}
      text={mono(note)}
      time={time ?? age(note.at, now)}
      unread={note.unread}
      needs={note.live}
      answers={note.live ? <NoteAnswers note={note} sessions={sessions} /> : undefined}
      href={note.href}
      external={note.external}
      onOpen={(e: MouseEvent<HTMLAnchorElement>) => openNote(note, e)}
      onDismiss={note.live || !note.unread ? undefined : () => dismiss([note])}
      leaving={leaving}
      label={`${note.title}, ${ago(note.at, now)}`}
    />
  );
}

function PanelEmpty({ tab, snapshot }: { tab: NotificationTab; snapshot?: NotificationsSnapshot }) {
  const reported = snapshot?.state === 'reported' ? snapshot : undefined;
  const unconnected =
    snapshot?.state === 'none' ||
    reported?.status === 'not-installed' ||
    reported?.status === 'signed-out';
  let empty: ReactNode;
  if (tab === 'needs') {
    empty = (
      <EmptyState
        compact
        icon="check"
        title="Nothing needs you"
        body="When a session asks a question or wants permission, it shows up here first."
      />
    );
  } else if (tab === 'github' && unconnected) {
    empty = (
      <EmptyState
        compact
        title="GitHub isn’t connected"
        body={
          reported?.status === 'not-installed'
            ? 'JOC reads your GitHub notifications through gh on your machine.'
            : 'Sign gh in on a linked machine; JOC picks it up within a minute.'
        }
        command={
          reported?.status === 'not-installed'
            ? 'brew install gh && gh auth login'
            : 'gh auth login'
        }
      />
    );
  } else {
    empty = (
      <EmptyState
        compact
        title="Nothing needs you"
        body="Questions from sessions, review requests, mentions and failed CI on your PRs show up here."
      />
    );
  }
  return <div className="jn-panel__empty">{empty}</div>;
}

/**
 * Rows that just left, kept a moment so they fade out where they were, then dropped. The list's
 * counts never wait on them.
 */
function useLeaving(ids: string[], byId: Map<string, Note>) {
  const shown = useRef<{ ids: string[]; notes: Map<string, Note> }>({ ids: [], notes: new Map() });
  const leaving = useRef(new Map<string, Note>());
  const [, rerender] = useState(0);
  const present = new Set(ids);
  for (const id of shown.current.ids) {
    const was = shown.current.notes.get(id);
    if (!present.has(id) && was && !leaving.current.has(id)) leaving.current.set(id, was);
  }
  // One that came back isn't leaving.
  for (const id of ids) leaving.current.delete(id);
  const order = withLeaving(shown.current.ids, ids, new Set(leaving.current.keys()));
  const notes = new Map([...leaving.current, ...byId]);
  const key = [...leaving.current.keys()].join(' ');
  useEffect(() => {
    shown.current = { ids: order, notes };
  });
  // A timer per set of leaving rows.
  useEffect(() => {
    if (!key) return;
    const gone = key.split(' ');
    const timer = setTimeout(() => {
      for (const id of gone) leaving.current.delete(id);
      // Faded out: no longer among the rows drawn, so it isn't taken for leaving again.
      shown.current = {
        ids: shown.current.ids.filter((id) => !gone.includes(id)),
        notes: shown.current.notes,
      };
      rerender((n) => n + 1);
    }, LEAVE_MS);
    return () => clearTimeout(timer);
  }, [key]);
  return order.flatMap((id) => {
    const note = notes.get(id);
    return note ? [{ note, leaving: !present.has(id) }] : [];
  });
}

interface PanelProps {
  notes: Note[];
  sessions: Session[];
  snapshot?: NotificationsSnapshot;
  problem?: string;
  anchor: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}

/** The open panel: what needs you, by group. Arrivals wait while you read. */
function Panel({ notes, sessions, snapshot, problem, anchor, onClose }: PanelProps) {
  const prefs = usePrefs();
  const now = useNow();
  const tab = prefs.notificationTab;
  const [settings, setSettings] = useState(false);
  const [inList, setInList] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const [held, setHeld] = useState<Held>();

  const inThisTab = notes.filter((n) => inTab(n, tab));
  const byId = new Map(inThisTab.map((n) => [n.id, n]));
  // In the same render as the change: a note that went is off the list now, not after an effect.
  const current = hold(held, inThisTab, inList || scrolled);
  const latestKey = `${current.ids.join(' ')}|${current.waiting.join(' ')}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: kept when the list changes
  useEffect(() => setHeld(current), [latestKey]);
  const rows = useLeaving(current.ids, byId);
  const waiting = current.waiting.flatMap((id) => byId.get(id) ?? []);
  const unread = notes.filter((n) => n.unread);
  // Unread, as the bell counts them, so the bell, the tabs and the summary always agree.
  const count = (t: NotificationTab) =>
    notes.filter((n) => n.unread && inTab(n, t)).length || undefined;
  const clear = clearable(inThisTab);

  function showArrivals() {
    setHeld(hold(undefined, inThisTab, false));
    body.current?.scrollTo({ top: 0 });
  }

  return (
    <>
      <NotificationPanel
        id={PANEL_ID}
        summary={problem ?? (unread.length ? `${unread.length} unread` : 'Nothing unread')}
        tabs={[
          { id: 'all', label: 'All', count: count('all') },
          { id: 'needs', label: 'Needs you', state: 'needs', count: count('needs') },
          { id: 'github', label: 'GitHub', count: count('github') },
        ]}
        tab={tab}
        onTabChange={(id) => {
          const parsed = NotificationTab.safeParse(id);
          if (parsed.success) {
            updatePrefs({ notificationTab: parsed.data });
            setHeld(undefined);
          }
        }}
        onClearAll={clear.length ? () => dismiss(clear) : undefined}
        onSettings={() => setSettings(true)}
        historyHref="/notifications"
        onClose={() => {
          if (!settings) onClose();
        }}
        anchor={anchor}
        bodyRef={body}
        onPointerLeave={() => setInList(false)}
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
        arrivals={
          <ArrivalsPill
            count={waiting.length}
            needs={waiting.filter((n) => n.live).length}
            onShow={showArrivals}
          />
        }
      >
        {rows.length ? (
          <div onPointerEnter={() => setInList(true)} onPointerLeave={() => setInList(false)}>
            {groupNotes(rows.map((r) => ({ ...r, group: r.note.group }))).map(([group, list]) => (
              <NotificationGroup
                key={group}
                label={GROUP_LABEL[group]}
                count={list.filter((r) => !r.leaving).length || undefined}
                hint={group === 'needs' ? 'Stays until answered' : undefined}
              >
                {list.map(({ note, leaving }) => (
                  <NoteRow
                    key={note.id}
                    note={note}
                    leaving={leaving}
                    now={now}
                    sessions={sessions}
                  />
                ))}
              </NotificationGroup>
            ))}
          </div>
        ) : (
          <PanelEmpty tab={tab} snapshot={snapshot} />
        )}
      </NotificationPanel>
      {settings ? <NotificationSettingsDialog onClose={() => setSettings(false)} /> : null}
    </>
  );
}

/** Goes where a note points, from a toast or a desktop notification. */
function follow(note: Note) {
  if (openNote(note)) return;
  if (note.external) window.open(note.href, '_blank', 'noopener,noreferrer');
  else location.assign(note.href);
}

function showDesktop(note: Note) {
  const prefs = currentPrefs();
  if (!prefs.browserNotifications || !channelsOf(prefs, note.kind).desktop) return;
  if (!supported() || Notification.permission !== 'granted') return;
  if (prefs.desktopWhenAway && document.hasFocus()) return;
  const n = new Notification(note.title, { body: note.text ?? note.source, tag: note.id });
  n.onclick = () => {
    window.focus();
    follow(note);
    n.close();
  };
}

/** "Send a test" in the settings: the chime, a toast, and a desktop notification if allowed. */
const testListeners = new Set<() => void>();
export function sendTestNotification() {
  chime.test();
  for (const listener of testListeners) listener();
  const prefs = currentPrefs();
  if (prefs.browserNotifications && supported() && Notification.permission === 'granted') {
    const n = new Notification('Notifications are on', {
      body: 'This is how JOC tells you something needs you.',
      tag: 'joc-test',
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  }
}

/**
 * News since the page opened, as toasts, the chime, the bell's pulse and desktop notifications,
 * by the person's choices. What was there when everything loaded isn't news, so a reload never
 * repeats one, and never chimes.
 */
function useArrivals(
  notes: Note[],
  loaded: boolean,
  viewing: string | undefined,
): { toasts: Note[]; arrivals: number } {
  const seen = useRef<Set<string>>(undefined);
  const [toasts, setToasts] = useState<string[]>([]);
  const [arrivals, setArrivals] = useState(0);
  const ids = notes.map((n) => n.id).join(' ');
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the set of notes changes
  useEffect(() => {
    if (!loaded) return;
    const before = seen.current;
    seen.current = new Set(notes.map((n) => n.id));
    if (!before) return;
    const news = arrived(before, notes, viewing);
    if (!news.length) return;
    const prefs = currentPrefs();
    const { toasts: toast, chime: ring } = attention(news, prefs);
    if (toast.length) setToasts((list) => [...list, ...toast.map((n) => n.id)]);
    if (ring) chime.play();
    if (panelNotes(news, prefs).length) setArrivals((n) => n + 1);
    for (const n of news) showDesktop(n);
  }, [ids, loaded]);
  const byId = new Map(notes.map((n) => [n.id, n]));
  // A toast leaves once its note is read, resolved or dismissed, wherever that happened.
  return {
    toasts: toasts.flatMap((id) => {
      const n = byId.get(id);
      return n?.unread && n.sessionId !== (viewing ?? '\0') ? [n] : [];
    }),
    arrivals,
  };
}

const TONE = (n: Note) => (n.live ? 'needs' : n.kind === 'ci-failed' ? 'error' : 'neutral');

function NoteToast({
  note,
  sessions,
  onDismiss,
}: {
  note: Note;
  sessions: Session[];
  onDismiss: () => void;
}) {
  return (
    <Toast
      tone={TONE(note)}
      title={note.title}
      body={mono(note)}
      answers={note.live ? <NoteAnswers note={note} sessions={sessions} /> : undefined}
      action="Open"
      onAction={() => {
        follow(note);
        onDismiss();
      }}
      onDismiss={onDismiss}
      persist={note.live}
    />
  );
}

/**
 * Everything the bell drives, for the nav bar: its counts and toggle, and the panel, toasts and
 * tab title it raises. `n` toggles the panel from anywhere but a text field.
 */
export function useNotificationCenter(viewing: string | undefined): {
  bell: NotificationBellProps;
  overlay: ReactNode;
} {
  const prefs = usePrefs();
  const { notes, loaded, sessions, snapshot, problem } = useNotes();
  const panel = panelNotes(notes, prefs);
  const counts = bellCounts(panel);
  const [open, setOpen] = useState(false);
  const bell = useRef<HTMLButtonElement>(null);
  const { toasts, arrivals } = useArrivals(notes, loaded, viewing);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [tests, setTests] = useState(0);

  useEffect(() => {
    document.title = pageTitle(counts.needs);
  }, [counts.needs]);

  useEffect(() => {
    const onTest = () => setTests((n) => n + 1);
    testListeners.add(onTest);
    return () => {
      testListeners.delete(onTest);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'n' || e.metaKey || e.ctrlKey || e.altKey) return;
      const at = e.target;
      if (
        at instanceof HTMLElement &&
        (at.isContentEditable || at.closest('input, textarea, select, dialog'))
      ) {
        return;
      }
      e.preventDefault();
      setOpen((o) => !o);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const stack = toasts.filter((n) => !dismissed.has(n.id));
  // Answers from here that came after Claude Code was answered: said once, then gone.
  const dropped = droppedAnswers(sessions, useSent()).filter(
    (d) => !dismissed.has(`answer:${d.waitingId}`),
  );
  // Oldest stay put; newer ones wait behind the "more" bar. Newest of those shown on top. While
  // the panel is open it has them all, so the stack steps aside.
  const visible = stack.slice(0, MAX_TOASTS).reverse();
  const hide = (id: string) => setDismissed((s) => new Set([...s, id]));
  const test = tests > 0 && !dismissed.has(`test:${tests}`);

  return {
    bell: {
      unread: counts.unread,
      needs: counts.needs,
      arrivals,
      open,
      onToggle: () => setOpen((o) => !o),
      controls: open ? PANEL_ID : undefined,
      buttonRef: bell,
    },
    overlay: (
      <>
        {open ? (
          <Panel
            notes={panel}
            sessions={sessions}
            snapshot={snapshot}
            problem={problem}
            anchor={bell}
            onClose={() => setOpen(false)}
          />
        ) : null}
        {(visible.length || dropped.length || test) && !open ? (
          <ToastStack more={stack.length - visible.length} onOpenMore={() => setOpen(true)}>
            {test ? (
              <Toast
                key={`test:${tests}`}
                title="Notifications are on"
                body="This is how JOC tells you something needs you."
                onDismiss={() => hide(`test:${tests}`)}
              />
            ) : null}
            {visible.map((n) => (
              <NoteToast key={n.id} note={n} sessions={sessions} onDismiss={() => hide(n.id)} />
            ))}
            {dropped.map((d) => (
              <Toast
                key={d.waitingId}
                title="Answered in Claude Code"
                body={`${d.title ?? 'The session'} was answered there first, so your answer from JOC wasn’t used.`}
                onDismiss={() => hide(`answer:${d.waitingId}`)}
              />
            ))}
          </ToastStack>
        ) : null}
      </>
    ),
  };
}

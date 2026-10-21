import { channelsOf, type NotificationsSnapshot, type Session } from '@joc/protocol';
import {
  type NotificationBellProps,
  NotificationEmpty,
  NotificationGroup,
  NotificationNewBar,
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
  type Note,
  pageTitle,
  panelNotes,
  withLeaving,
} from './notes.ts';
import { supported } from './notify.ts';
import { currentPrefs, usePrefs } from './prefs.ts';
import { chime } from './sound.ts';
import { age, ago } from './time.ts';

// The notification center: the bell's panel over the page, the toasts, the chime, desktop
// notifications and the tab's title. Sessions waiting on you come first everywhere and stay
// until they stop waiting. Every action shows in the same frame; the server hears after.

const PANEL_ID = 'joc-notifications';
const MAX_TOASTS = 3;
/** = --duration-fast: how long a leaving row takes to fade out before it goes. */
const LEAVE_MS = 140;
/** Arrivals this close together share the count's one pulse. */
const PULSE_SHARED_MS = 2_000;

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

interface NoteRowProps {
  note: Note;
  now: number;
  sessions: Session[];
  /** The history's clock time instead of an age. */
  time?: string;
  leaving?: boolean;
}

/** One note's row: opening it reads it; the ✕ dismisses it; a needs row may answer inline. */
export function NoteRow({ note, now, sessions, time, leaving }: NoteRowProps) {
  return (
    <NotificationRow
      lead={note.lead}
      title={note.title}
      meta={note.meta}
      code={note.code}
      time={time ?? age(note.at, now)}
      read={!note.unread}
      needs={note.live}
      actions={
        note.live && note.answer ? <NoteAnswers note={note} sessions={sessions} /> : undefined
      }
      href={note.href}
      external={note.external}
      onOpen={(e: MouseEvent<HTMLAnchorElement>) => openNote(note, e)}
      onDismiss={note.live || !note.unread ? undefined : () => dismiss([note])}
      leaving={leaving}
      label={`${note.title}, ${ago(note.at, now)}`}
    />
  );
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
  problem?: string;
  anchor: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}

/**
 * The open panel: one list, needs you pinned first, then activity, newest first. What arrives
 * while it's open waits behind the new-items bar; a row that's handled or dismissed fades out and
 * leaves at once.
 */
function Panel({ notes, sessions, problem, anchor, onClose }: PanelProps) {
  const now = useNow();
  const [settings, setSettings] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const [held, setHeld] = useState<Held>();

  const byId = new Map(notes.map((n) => [n.id, n]));
  // In the same render as the change: a note that went is off the list now, not after an effect.
  const current = hold(held, notes, true);
  const latestKey = `${current.ids.join(' ')}|${current.waiting.join(' ')}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: kept when the list changes
  useEffect(() => setHeld(current), [latestKey]);
  const rows = useLeaving(current.ids, byId);
  const clear = clearable(notes);
  const groups = groupNotes(rows.map((r) => ({ ...r, group: r.note.group })));
  const needsShown = groups.some(([g]) => g === 'needs');

  function showArrivals() {
    setHeld(hold(undefined, notes, false));
    list.current?.scrollTo({ top: 0 });
  }

  return (
    <>
      <NotificationPanel
        id={PANEL_ID}
        note={problem}
        onClearAll={clear.length ? () => dismiss(clear) : undefined}
        onSettings={() => setSettings(true)}
        foot={
          <a className="joc-notif-link" href="/notifications">
            History
          </a>
        }
        onClose={() => {
          if (!settings) onClose();
        }}
        anchor={anchor}
        listRef={list}
        arrivals={<NotificationNewBar count={current.waiting.length} onShow={showArrivals} />}
      >
        {rows.length ? (
          groups.map(([group, items]) => (
            <NotificationGroup
              key={group}
              label={GROUP_LABEL[group]}
              count={group === 'needs' ? items.filter((r) => !r.leaving).length : undefined}
              bare={group === 'activity' && !needsShown}
            >
              {items.map(({ note, leaving }) => (
                <NoteRow
                  key={note.id}
                  note={note}
                  leaving={leaving}
                  now={now}
                  sessions={sessions}
                />
              ))}
            </NotificationGroup>
          ))
        ) : current.waiting.length ? null : (
          <NotificationEmpty
            title="All caught up"
            body="Sessions that need you, review requests, mentions and CI failures on your PRs show up here."
          />
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

/** A desktop notification, only while JOC isn't the focused window, and the browser allows it. */
function showDesktop(note: Note) {
  if (!channelsOf(currentPrefs(), note.kind).desktop) return;
  if (!supported() || Notification.permission !== 'granted' || document.hasFocus()) return;
  const n = new Notification(note.toastTitle ?? note.title, {
    body: note.text ?? note.meta,
    tag: note.id,
  });
  n.onclick = () => {
    window.focus();
    follow(note);
    n.close();
  };
}

/** "Send a test" in the settings: the chime, a toast, and a desktop notification if allowed. */
const testListeners = new Set<() => void>();
export function sendTestNotification() {
  if (currentPrefs().notificationSound) chime.test();
  for (const listener of testListeners) listener();
  if (supported() && Notification.permission === 'granted') {
    const n = new Notification('Test: a session needs you', {
      body: 'This is how a needs-you notification looks and sounds.',
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
): { toasts: Note[]; arrivals: number; needsArrivals: number } {
  const seen = useRef<Set<string>>(undefined);
  const [toasts, setToasts] = useState<string[]>([]);
  const [arrivals, setArrivals] = useState(0);
  const [needsArrivals, setNeedsArrivals] = useState(0);
  const pulsed = useRef({ any: Number.NEGATIVE_INFINITY, needs: Number.NEGATIVE_INFINITY });
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
    // One pulse for arrivals close together: a burst doesn't flash the count again and again.
    const at = Date.now();
    if (panelNotes(news, prefs).length && at - pulsed.current.any >= PULSE_SHARED_MS) {
      pulsed.current.any = at;
      setArrivals((n) => n + 1);
    }
    if (news.some((n) => n.live) && at - pulsed.current.needs >= PULSE_SHARED_MS) {
      pulsed.current.needs = at;
      setNeedsArrivals((n) => n + 1);
    }
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
    needsArrivals,
  };
}

const TONE = (n: Note) => (n.live ? 'needs' : n.kind === 'ci-failed' ? 'error' : 'neutral');

/**
 * A note's toast. Needs you stays until it's answered (anywhere) or opened, with Answer to open
 * the session; the rest leave after five seconds and stay in the panel.
 */
function NoteToast({ note, onDismiss }: { note: Note; onDismiss: () => void }) {
  return (
    <Toast
      tone={TONE(note)}
      title={note.toastTitle ?? note.title}
      body={note.text ?? note.meta}
      action={note.live ? 'Answer' : 'Open'}
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
  /** Counts arrivals of sessions needing you, for the Sessions item's pulse. */
  needsArrivals: number;
  overlay: ReactNode;
} {
  const prefs = usePrefs();
  const { notes, loaded, sessions, problem } = useNotes();
  const panel = panelNotes(notes, prefs);
  const counts = bellCounts(panel);
  const [open, setOpen] = useState(false);
  const bell = useRef<HTMLButtonElement>(null);
  const { toasts, arrivals, needsArrivals } = useArrivals(notes, loaded, viewing);
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
    needsArrivals,
    overlay: (
      <>
        {open ? (
          <Panel
            notes={panel}
            sessions={sessions}
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
                tone="needs"
                title="Test: a session needs you"
                body="This is how a needs-you notification looks and sounds."
                action="Answer"
                onAction={() => hide(`test:${tests}`)}
                onDismiss={() => hide(`test:${tests}`)}
                persist={false}
              />
            ) : null}
            {visible.map((n) => (
              <NoteToast key={n.id} note={n} onDismiss={() => hide(n.id)} />
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

import {
  channelsOf,
  type NotificationsSnapshot,
  NotificationTab,
  type PullRequest,
  type Session,
} from '@joc/protocol';
import {
  ArrivalsPill,
  EmptyState,
  type NotificationAction,
  type NotificationBellProps,
  NotificationGroup,
  NotificationPanel,
  NotificationRow,
  Toast,
  ToastStack,
} from '@joc/ui';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { apiFetch } from './auth.ts';
import { useAlerts, useGitHub, useNotifications, useNow, useSessions } from './hooks.ts';
import { sessionForThread } from './links.ts';
import { NotificationSettingsDialog } from './NotificationSettings.tsx';
import { applyLocal, clearNotes, markRead, useNoteChanges } from './note-actions.ts';
import {
  allNotes,
  arrived,
  bellCounts,
  ciPrompt,
  GROUP_LABEL,
  groupNotes,
  type Held,
  hold,
  inTab,
  type Note,
  pageTitle,
  panelNotes,
} from './notes.ts';
import { supported } from './notify.ts';
import { currentPrefs, updatePrefs, usePrefs } from './prefs.ts';
import { age, ago } from './time.ts';

// The notification center: the bell's panel over the page, the toasts, desktop notifications
// and the tab's title. Sessions waiting on you come first everywhere and stay until they stop
// waiting.

const PANEL_ID = 'joc-notifications';
const MAX_TOASTS = 3;

/** Every note with what was done here applied, and whether all their sources have loaded. */
export function useNotes(records = false): {
  notes: Note[];
  loaded: boolean;
  sessions: Session[];
  connected: boolean;
  snapshot: NotificationsSnapshot | undefined;
} {
  const { sessions, connected } = useSessions();
  const alerts = useAlerts();
  const snapshot = useNotifications();
  useNoteChanges();
  const threads = snapshot?.state === 'reported' ? snapshot.threads : [];
  return {
    notes: applyLocal(allNotes(sessions, alerts ?? [], threads, records)),
    loaded: connected && alerts !== undefined && snapshot !== undefined,
    sessions,
    connected,
    snapshot,
  };
}

async function sendPrompt(sessionId: string, text: string): Promise<boolean> {
  const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/prompts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, images: [] }),
  }).catch(() => undefined);
  return res?.ok === true;
}

/** Prompts sent from a note this page, so its button says so. */
const sent = new Map<string, 'sending' | 'sent' | 'failed'>();

/**
 * A note's one action: open the session it's about, review the PR in JOC, send a failed CI run
 * to the session on its branch, or open it on GitHub. Acting on a note marks it read.
 */
function useAction(
  note: Note,
  sessions: Session[],
  prs: PullRequest[],
): NotificationAction & { run: () => void } {
  const [, rerender] = useState(0);
  const read = () => void markRead([note]);
  const open = (label = 'Open'): NotificationAction & { run: () => void } => ({
    label,
    href: note.href,
    external: note.external,
    onClick: read,
    run: () => {
      read();
      if (note.external) window.open(note.href, '_blank', 'noopener,noreferrer');
      else location.assign(note.href);
    },
  });
  if (note.live) return open('Open session');
  if (note.kind === 'review' && note.number) {
    const href = `/pr?${new URLSearchParams({ repo: note.repo, number: String(note.number) })}`;
    return {
      label: 'Review',
      variant: 'secondary',
      href,
      onClick: read,
      run: () => {
        read();
        location.assign(href);
      },
    };
  }
  if (note.kind === 'ci-failed') {
    const session = sessionForThread(note, prs, sessions);
    if (session) {
      const state = sent.get(note.id);
      const send = async () => {
        if (state === 'sending' || state === 'sent') return;
        sent.set(note.id, 'sending');
        rerender((n) => n + 1);
        const ok = await sendPrompt(session.id, ciPrompt(note));
        sent.set(note.id, ok ? 'sent' : 'failed');
        rerender((n) => n + 1);
        if (ok) read();
      };
      return {
        label: state === 'sent' ? 'Sent' : state === 'failed' ? 'Try again' : 'Send to Claude',
        variant: 'secondary',
        disabled: state === 'sending' || state === 'sent',
        onClick: () => void send(),
        run: () => void send(),
      };
    }
  }
  return open();
}

const mono = (note: Note): ReactNode =>
  note.mono && note.text ? <code>{note.text}</code> : note.text;

interface NoteRowProps {
  note: Note;
  gone?: boolean;
  now: number;
  sessions: Session[];
  prs: PullRequest[];
  /** The history's clock time instead of an age. */
  time?: string;
}

export function NoteRow({ note, gone, now, sessions, prs, time }: NoteRowProps) {
  const action = useAction(note, sessions, prs);
  return (
    <NotificationRow
      lead={note.lead}
      title={note.title}
      source={note.source}
      text={mono(note)}
      time={time ?? age(note.at, now)}
      unread={note.unread}
      needs={note.live}
      answers={
        note.live ? <span className="jn-answers__note">Answer it in Claude Code</span> : undefined
      }
      action={action}
      onMarkRead={note.live ? undefined : () => void markRead([note])}
      onClear={note.live ? undefined : () => void clearNotes([note])}
      gone={gone}
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
        title="No notifications"
        body="Questions from sessions, review requests and CI on your PRs show up here."
      />
    );
  }
  return <div className="jn-panel__empty">{empty}</div>;
}

interface PanelProps {
  notes: Note[];
  sessions: Session[];
  snapshot?: NotificationsSnapshot;
  anchor: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}

/** The open panel: the notes by group, held still while you read them. */
function Panel({ notes, sessions, snapshot, anchor, onClose }: PanelProps) {
  const prefs = usePrefs();
  const now = useNow();
  const github = useGitHub();
  const prs = github?.state === 'reported' ? [...github.reviewRequested, ...github.mine] : [];
  const tab = prefs.notificationTab;
  const [settings, setSettings] = useState(false);
  const [inList, setInList] = useState(false);
  const [inPanel, setInPanel] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const [held, setHeld] = useState<Held>();
  // The last version of each note seen, so a cleared one's slot keeps its height.
  const cache = useRef(new Map<string, Note>());

  const inThisTab = notes.filter((n) => inTab(n, tab));
  const latestKey = inThisTab.map((n) => n.id).join(' ');
  const arrivals = inList || scrolled;
  // biome-ignore lint/correctness/useExhaustiveDependencies: recomputed when the ids or holds change
  useEffect(() => {
    setHeld((h) => hold(h, inThisTab, { arrivals, slots: inPanel }));
  }, [latestKey, arrivals, inPanel]);

  const byId = new Map(inThisTab.map((n) => [n.id, n]));
  for (const n of inThisTab) cache.current.set(n.id, n);
  const shown = (held?.ids ?? inThisTab.map((n) => n.id)).flatMap((id) => {
    const live = byId.get(id);
    if (live) return [{ note: live, gone: false }];
    const last = cache.current.get(id);
    return last ? [{ note: last, gone: true }] : [];
  });
  const waiting = (held?.waiting ?? []).flatMap((id) => byId.get(id) ?? []);
  const unread = notes.filter((n) => n.unread);
  const read = notes.filter((n) => !n.unread && !n.live);
  const count = (t: NotificationTab) => notes.filter((n) => inTab(n, t)).length || undefined;

  function showArrivals() {
    setHeld(hold(held, inThisTab, { arrivals: false, slots: false }));
    body.current?.scrollTo({ top: 0 });
  }

  return (
    <>
      <NotificationPanel
        id={PANEL_ID}
        summary={unread.length ? `${unread.length} unread` : 'Nothing unread'}
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
        onMarkAllRead={unread.some((n) => !n.live) ? () => void markRead(unread) : undefined}
        onClearRead={read.length ? () => void clearNotes(read) : undefined}
        onSettings={() => setSettings(true)}
        historyHref="/notifications"
        onClose={() => {
          if (!settings) onClose();
        }}
        anchor={anchor}
        bodyRef={body}
        onPointerEnter={() => setInPanel(true)}
        onPointerLeave={() => {
          setInPanel(false);
          setInList(false);
        }}
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
        arrivals={
          <ArrivalsPill
            count={waiting.length}
            needs={waiting.filter((n) => n.live).length}
            onShow={showArrivals}
          />
        }
      >
        {shown.length ? (
          <div onPointerEnter={() => setInList(true)} onPointerLeave={() => setInList(false)}>
            {groupNotes(shown.map((s) => ({ ...s, group: s.note.group }))).map(([group, list]) => (
              <NotificationGroup
                key={group}
                label={GROUP_LABEL[group]}
                count={list.filter((s) => !s.gone).length}
                hint={group === 'needs' ? 'Stays until answered' : undefined}
              >
                {list.map(({ note, gone }) => (
                  <NoteRow
                    key={note.id}
                    note={note}
                    gone={gone}
                    now={now}
                    sessions={sessions}
                    prs={prs}
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

function showDesktop(note: Note) {
  const prefs = currentPrefs();
  if (!prefs.browserNotifications || !channelsOf(prefs, note.kind).desktop) return;
  if (!supported() || Notification.permission !== 'granted') return;
  if (prefs.desktopWhenAway && document.hasFocus()) return;
  const n = new Notification(note.title, { body: note.text ?? note.source, tag: note.id });
  n.onclick = () => {
    window.focus();
    void markRead([note]);
    if (note.external) window.open(note.href, '_blank', 'noopener,noreferrer');
    else location.assign(note.href);
    n.close();
  };
}

/**
 * News since the page opened, as toasts and desktop notifications, by the person's choices. What
 * was there when everything loaded isn't news, so a reload never repeats one.
 */
function useArrivals(notes: Note[], loaded: boolean, viewing: string | undefined): Note[] {
  const seen = useRef<Set<string>>(undefined);
  const [toasts, setToasts] = useState<string[]>([]);
  const ids = notes.map((n) => n.id).join(' ');
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the set of notes changes
  useEffect(() => {
    if (!loaded) return;
    const before = seen.current;
    seen.current = new Set(notes.map((n) => n.id));
    if (!before) return;
    const news = arrived(before, notes, viewing);
    const prefs = currentPrefs();
    const toast = news.filter((n) => channelsOf(prefs, n.kind).toast).map((n) => n.id);
    if (toast.length) setToasts((list) => [...list, ...toast]);
    for (const n of news) showDesktop(n);
  }, [ids, loaded]);
  const byId = new Map(notes.map((n) => [n.id, n]));
  // A toast leaves once its note is read, resolved or cleared, wherever that happened.
  return toasts.flatMap((id) => {
    const n = byId.get(id);
    return n?.unread && n.sessionId !== (viewing ?? '\0') ? [n] : [];
  });
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
  const action = useAction(note, sessions, []);
  return (
    <Toast
      tone={TONE(note)}
      title={note.title}
      body={mono(note)}
      action={action.label}
      onAction={() => {
        action.run();
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
  const { notes, loaded, sessions, snapshot } = useNotes();
  const panel = panelNotes(notes, prefs);
  const counts = bellCounts(panel);
  const [open, setOpen] = useState(false);
  const bell = useRef<HTMLButtonElement>(null);
  const toasts = useArrivals(notes, loaded, viewing);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    document.title = pageTitle(counts.needs);
  }, [counts.needs]);

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
  // Oldest stay put; newer ones wait behind the "more" bar. Newest of those shown on top. While
  // the panel is open it has them all, so the stack steps aside.
  const visible = stack.slice(0, MAX_TOASTS).reverse();
  const dismiss = (id: string) => setDismissed((s) => new Set([...s, id]));

  return {
    bell: {
      unread: counts.unread,
      needs: counts.needs,
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
            anchor={bell}
            onClose={() => setOpen(false)}
          />
        ) : null}
        {visible.length && !open ? (
          <ToastStack more={stack.length - visible.length} onOpenMore={() => setOpen(true)}>
            {visible.map((n) => (
              <NoteToast key={n.id} note={n} sessions={sessions} onDismiss={() => dismiss(n.id)} />
            ))}
          </ToastStack>
        ) : null}
      </>
    ),
  };
}

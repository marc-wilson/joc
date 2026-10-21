import { Button, cx, EmptyState, NotificationGroup, SectionHeader, TextInput } from '@joc/ui';
import { useEffect, useState } from 'react';
import { useNow } from './hooks.ts';
import { Nav } from './Nav.tsx';
import { NoteRow, useNotes } from './Notifications.tsx';
import { dismiss } from './note-data.ts';
import { clearable, type Note, type NoteGroup } from './notes.ts';

// /notifications: everything to look back on, in day groups with clock times, the resolved and
// dismissed ones too. JOC keeps its own alerts for 30 days; GitHub's are the unread ones your
// plugin last read.

type View = 'all' | NoteGroup;

const VIEWS: { id: View; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'needs', label: 'Needs you' },
  { id: 'activity', label: 'Activity' },
];

const SEARCH_ID = 'notification-search';

const dayKey = (iso: string) => new Date(iso).toDateString();

function dayLabel(iso: string, now: number): string {
  const day = new Date(iso);
  const today = new Date(now);
  if (day.toDateString() === today.toDateString()) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(today.getDate() - 1);
  if (day.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return day.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

const matches = (n: Note, query: string) => {
  const q = query.trim().toLowerCase();
  return !q || [n.title, n.meta, n.code ?? '', n.repo].some((s) => s.toLowerCase().includes(q));
};

/** `/` jumps to the search, unless the person is already typing somewhere. */
function useSearchShortcut() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const at = e.target;
      if (at instanceof HTMLElement && (at.isContentEditable || at.closest('input, textarea'))) {
        return;
      }
      e.preventDefault();
      document.getElementById(SEARCH_ID)?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}

export function NotificationsPage() {
  const { notes, loaded, sessions, connected, problem } = useNotes(true);
  const now = useNow();
  const [query, setQuery] = useState('');
  const [view, setView] = useState<View>('all');
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [unreadOnly, setUnreadOnly] = useState(false);
  useSearchShortcut();

  const repos = [...new Set(notes.map((n) => n.repo))].sort();
  const filtered = notes.filter(
    (n) => !hidden.has(n.repo) && (!unreadOnly || n.unread) && matches(n, query),
  );
  const shown = filtered
    .filter((n) => view === 'all' || n.group === view)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const days = new Map<string, Note[]>();
  for (const n of shown) days.set(dayKey(n.at), [...(days.get(dayKey(n.at)) ?? []), n]);
  const clear = clearable(notes);

  return (
    <div className="joc-app app app-notif-page">
      <Nav page="notifications" connected={connected} />
      <div className="joc-app__body">
        <aside className="app-notif-filters" aria-label="Filters">
          <TextInput
            id={SEARCH_ID}
            placeholder="Search notifications"
            kbd="/"
            value={query}
            onChange={setQuery}
          />
          <nav className="app-notif-filters__views" aria-label="Show">
            {VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                className={cx('joc-nav__link', view === v.id && 'is-active')}
                aria-pressed={view === v.id}
                onClick={() => setView(v.id)}
              >
                {v.label}
                <span className="joc-nav__count app-notif-filters__count">
                  {filtered.filter((n) => v.id === 'all' || n.group === v.id).length}
                </span>
              </button>
            ))}
          </nav>
          {repos.length ? (
            <fieldset className="app-notif-filters__repos">
              <legend className="joc-notif-label">Repositories</legend>
              {repos.map((repo) => (
                <label key={repo} className="app-notif-filters__repo">
                  <input
                    type="checkbox"
                    className="joc-notif-check"
                    checked={!hidden.has(repo)}
                    onChange={(e) => {
                      const next = new Set(hidden);
                      if (e.target.checked) next.delete(repo);
                      else next.add(repo);
                      setHidden(next);
                    }}
                  />
                  {repo}
                </label>
              ))}
            </fieldset>
          ) : null}
          <label className="app-notif-filters__check">
            <input
              type="checkbox"
              className="joc-notif-check"
              checked={unreadOnly}
              onChange={(e) => setUnreadOnly(e.target.checked)}
            />
            Unread only
          </label>
        </aside>
        <main className="joc-app__main app-notif-history">
          <div className="app-notif-history__inner">
            <SectionHeader
              size="lg"
              title="Notifications"
              count={notes.length || undefined}
              description={
                problem ??
                "JOC's alerts from the last 30 days and your unread GitHub notifications, newest first."
              }
            >
              <Button variant="secondary" disabled={!clear.length} onClick={() => dismiss(clear)}>
                Clear all
              </Button>
            </SectionHeader>
            {shown.length ? (
              <div className="app-notif-history__list">
                {[...days].map(([key, list]) => (
                  <NotificationGroup
                    key={key}
                    label={dayLabel(list[0]?.at ?? key, now)}
                    count={list.length}
                  >
                    {list.map((n) => (
                      <NoteRow
                        key={n.id}
                        note={n}
                        now={now}
                        sessions={sessions}
                        time={clock(n.at)}
                      />
                    ))}
                  </NotificationGroup>
                ))}
              </div>
            ) : loaded ? (
              <EmptyState
                title={notes.length ? 'Nothing matches' : 'No notifications'}
                body={
                  notes.length
                    ? 'Try another search, view or repository.'
                    : 'Questions from sessions, review requests, mentions and CI on your PRs show up here.'
                }
              />
            ) : null}
          </div>
        </main>
      </div>
    </div>
  );
}

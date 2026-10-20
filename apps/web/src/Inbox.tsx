import type { Alert } from '@joc/protocol';
import { Button, EmptyState, InboxRow, SectionHeader, SetupCheck, Switch } from '@joc/ui';
import { useEffect, useState } from 'react';
import { alertRow, settle } from './alert-list.ts';
import { apiFetch } from './auth.ts';
import {
  changeAlerts,
  useAlerts,
  useGitHub,
  useNotifications,
  useNow,
  useSessions,
} from './hooks.ts';
import {
  groupThreads,
  type InboxThread,
  markOf,
  mergeThreads,
  referenceOf,
  verbOf,
} from './inbox.ts';
import { sessionForThread } from './links.ts';
import { Nav } from './Nav.tsx';
import { supported } from './notify.ts';
import { updatePrefs, usePrefs } from './prefs.ts';
import { ago } from './time.ts';

type Permission = 'unsupported' | NotificationPermission;

const permissionHere = (): Permission => (supported() ? Notification.permission : 'unsupported');

/**
 * The one switch for browser notifications. The switch is the person's, wherever they sign in;
 * whether this browser may show them is the browser's own, so it's asked here when needed.
 */
function AlertsSwitch() {
  const on = usePrefs().browserNotifications;
  const [permission, setPermission] = useState<Permission>(permissionHere);

  // Allowed or blocked in the browser's own settings while the page is open.
  useEffect(() => {
    let status: PermissionStatus | undefined;
    const update = () => setPermission(permissionHere());
    navigator.permissions
      ?.query({ name: 'notifications' })
      .then((s) => {
        status = s;
        s.addEventListener('change', update);
      })
      .catch(() => {});
    return () => status?.removeEventListener('change', update);
  }, []);

  async function allow() {
    setPermission(await Notification.requestPermission());
  }

  function toggle(next: boolean) {
    updatePrefs({ browserNotifications: next });
    if (next && permission === 'default') void allow();
  }

  const hint =
    permission === 'unsupported'
      ? "This browser can't show notifications."
      : !on
        ? undefined
        : permission === 'denied'
          ? "On, but blocked in this browser. Allow notifications for this site in the browser's settings."
          : permission === 'default'
            ? "On, but this browser hasn't been allowed to show them yet."
            : undefined;
  return (
    <Switch
      label="Browser notifications"
      description="Review requests, mentions, failing CI and sessions that need you, while JOC is open."
      hint={hint}
      checked={on}
      // Unsupported here, it can still be turned off.
      disabled={permission === 'unsupported' && !on}
      action={
        on && permission === 'default' ? (
          <Button variant="secondary" size="sm" onClick={() => void allow()}>
            Allow in this browser
          </Button>
        ) : undefined
      }
      onChange={toggle}
    />
  );
}

async function post(path: string, body: unknown): Promise<boolean> {
  const res = await apiFetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => undefined); // Unreachable: reported as not marked, below.
  return res?.ok === true;
}

/**
 * The Inbox's alerts, held still while read (see `settle`): marking read and clearing show at
 * once, and come back if the server didn't take them.
 */
function useAlertsView() {
  const alerts = useAlerts();
  const [view, setView] = useState<{ shown?: Alert[]; fresh: Alert[] }>({ fresh: [] });
  const [read, setRead] = useState<Set<string>>(() => new Set());
  const [cleared, setCleared] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (alerts) setView((v) => settle(v.shown, alerts));
  }, [alerts]);

  async function apply(
    set: typeof setRead,
    action: 'read' | 'clear',
    ids: string[],
  ): Promise<void> {
    if (!ids.length) return;
    set((s) => new Set([...s, ...ids]));
    if (await changeAlerts(action, ids)) return;
    set((s) => new Set([...s].filter((id) => !ids.includes(id))));
  }

  const visible = (list: Alert[]) => list.filter((a) => !cleared.has(a.id));
  return {
    loaded: view.shown !== undefined,
    shown: visible(view.shown ?? []),
    fresh: visible(view.fresh),
    isRead: (a: Alert) => a.read || read.has(a.id),
    markRead: (ids: string[]) => apply(setRead, 'read', ids),
    clear: (ids: string[]) => apply(setCleared, 'clear', ids),
    showFresh: () => alerts && setView({ shown: alerts, fresh: [] }),
  };
}

type AlertsView = ReturnType<typeof useAlertsView>;

/** JOC's own alerts, kept on the server to look back on: each can be read and cleared. */
function AlertsSection({ view, now }: { view: AlertsView; now: number }) {
  const { shown, fresh } = view;
  const all = [...fresh, ...shown];
  return (
    <section className="app-inbox-group" aria-label="Alerts">
      <SectionHeader
        title="Alerts"
        count={shown.length || undefined}
        description="Sessions that needed you or finished, and new review requests. Kept for 30 days."
      >
        {fresh.length ? (
          <Button variant="secondary" size="sm" onClick={view.showFresh}>
            Show {fresh.length} new
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          icon="x"
          disabled={!all.length}
          onClick={() => void view.clear(all.map((a) => a.id))}
        >
          Clear all
        </Button>
      </SectionHeader>
      {shown.length ? (
        <div className="app-list">
          {shown.map((a) => (
            <InboxRow
              key={a.id}
              title={a.title}
              {...alertRow(a)}
              updated={ago(a.at, now)}
              read={view.isRead(a)}
              onMarkRead={() => void view.markRead([a.id])}
              onClear={() => void view.clear([a.id])}
            />
          ))}
        </div>
      ) : view.loaded && !fresh.length ? (
        <EmptyState
          compact
          title="No alerts"
          body="When a session needs you or finishes, or a pull request asks for your review, it's kept here."
        />
      ) : null}
    </section>
  );
}

/**
 * /inbox: JOC's alerts, then unread GitHub notifications, grouped by why they want you, review
 * requests first.
 */
export function InboxPage() {
  const notifications = useNotifications();
  const github = useGitHub();
  const { sessions, connected } = useSessions();
  const now = useNow();
  const alerts = useAlertsView();
  const [shown, setShown] = useState<InboxThread[]>([]);
  // Marked here and not yet out of the server's list.
  const [marked, setMarked] = useState<Set<string>>(() => new Set());
  const reported = notifications?.state === 'reported' ? notifications : undefined;
  const unread = reported?.threads;
  const prs = github?.state === 'reported' ? [...github.reviewRequested, ...github.mine] : [];

  useEffect(() => {
    if (unread) setShown((list) => mergeThreads(list, unread));
  }, [unread]);

  const isRead = (t: InboxThread) => t.read || marked.has(t.id);
  const left = shown.filter((t) => !isRead(t));
  const unreadAlerts = [...alerts.fresh, ...alerts.shown].filter((a) => !alerts.isRead(a));

  async function markRead(ids: string[], sent: Promise<boolean>) {
    setMarked((set) => new Set([...set, ...ids]));
    if (await sent) return;
    // Not marked after all: offer the button again.
    setMarked((set) => new Set([...set].filter((id) => !ids.includes(id))));
  }

  let body: React.ReactNode = null;
  if (notifications?.state === 'none') {
    body = (
      <EmptyState
        title="No GitHub notifications yet"
        body="Your plugin reads your GitHub notifications through the GitHub CLI about once a minute. Link a machine with /joc-login, and they show up here."
      />
    );
  } else if (reported?.status === 'not-installed') {
    body = (
      <SetupCheck
        status="missing"
        title="GitHub CLI not installed"
        detail="JOC reads your GitHub notifications through gh on your machine."
        command="brew install gh && gh auth login"
      />
    );
  } else if (reported?.status === 'signed-out') {
    body = (
      <SetupCheck
        status="missing"
        title="GitHub CLI not signed in"
        detail="Sign gh in on your machine; JOC picks it up within a minute."
        command="gh auth login"
      />
    );
  } else if (reported?.status === 'error') {
    body = (
      <EmptyState
        title="GitHub didn't answer"
        body="The last read through gh failed. Your plugin tries again every minute."
      />
    );
  } else if (reported && !shown.length) {
    body = (
      <EmptyState
        title="No GitHub notifications"
        body="Review requests, mentions, failing CI and comments on your pull requests and issues show up here."
      />
    );
  } else if (reported) {
    body = (
      <>
        {groupThreads(shown).map(([group, list]) => (
          <section key={group.label} className="app-inbox-group" aria-label={group.label}>
            <SectionHeader title={group.label} count={list.length} />
            <div className="app-list">
              {list.map((t) => {
                const session = sessionForThread(t, prs, sessions);
                return (
                  <InboxRow
                    key={t.id}
                    title={t.title}
                    href={t.url}
                    reference={referenceOf(t)}
                    mark={markOf(t)}
                    verb={verbOf(t)}
                    updated={ago(t.updatedAt, now)}
                    read={isRead(t)}
                    session={
                      session && {
                        title: session.title ?? 'New session',
                        state: session.state,
                        href: `/?session=${encodeURIComponent(session.id)}`,
                      }
                    }
                    onMarkRead={() =>
                      void markRead([t.id], post('/api/notifications/read', { ids: [t.id] }))
                    }
                  />
                );
              })}
            </div>
          </section>
        ))}
        {reported.more ? (
          <EmptyState
            compact
            title="Showing your newest notifications"
            body="Older unread ones are on GitHub."
          />
        ) : null}
      </>
    );
  }

  return (
    <div className="joc-app app">
      <Nav page="inbox" connected={connected} />
      <main className="joc-app__main app-page">
        <SectionHeader
          size="lg"
          title="Inbox"
          count={unreadAlerts.length + (unread?.length ?? 0) || undefined}
          description="JOC's alerts, then your GitHub notifications by reason. Read items stay where they are until you leave the page."
        >
          <Button
            icon="check"
            disabled={!left.length && !unreadAlerts.length}
            onClick={() => {
              void alerts.markRead(unreadAlerts.map((a) => a.id));
              if (left.length) {
                void markRead(
                  left.map((t) => t.id),
                  post('/api/notifications/read-all', {}),
                );
              }
            }}
          >
            Mark all read
          </Button>
        </SectionHeader>
        <AlertsSwitch />
        <AlertsSection view={alerts} now={now} />
        {body}
      </main>
    </div>
  );
}

import { Button, EmptyState, InboxRow, SectionHeader, SetupCheck, Switch } from '@joc/ui';
import { useEffect, useState } from 'react';
import { apiFetch } from './auth.ts';
import { useGitHub, useNotifications, useNow, useSessions } from './hooks.ts';
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
import { alertsOn, setAlertsOn, supported } from './notify.ts';
import { ago } from './time.ts';

type Permission = 'unsupported' | NotificationPermission;

/** The one switch for browser notifications, remembered in this browser. */
function AlertsSwitch() {
  const [on, setOn] = useState(alertsOn);
  const [permission, setPermission] = useState<Permission>(() =>
    supported() ? Notification.permission : 'unsupported',
  );

  async function toggle(next: boolean) {
    const answer =
      !next || permission === 'granted' ? permission : await Notification.requestPermission();
    setPermission(answer);
    const enabled = next && answer === 'granted';
    setAlertsOn(enabled);
    setOn(enabled);
  }

  const hint =
    permission === 'unsupported'
      ? "This browser can't show notifications."
      : permission === 'denied'
        ? "Notifications are blocked for this site. Allow them in your browser's settings."
        : undefined;
  return (
    <Switch
      label="Browser notifications"
      description="Review requests, mentions, failing CI and sessions that need you, while JOC is open."
      hint={hint}
      checked={on && permission === 'granted'}
      disabled={hint !== undefined}
      onChange={(next) => void toggle(next)}
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

/** /inbox: unread GitHub notifications, grouped by why they want you, review requests first. */
export function InboxPage() {
  const notifications = useNotifications();
  const github = useGitHub();
  const { sessions, connected } = useSessions();
  const now = useNow();
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
        title="No notifications yet"
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
        title="No notifications"
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
          count={unread?.length}
          description="GitHub notifications for you, grouped by reason. Read items stay where they are until you leave the page."
        >
          <Button
            icon="check"
            disabled={!left.length}
            onClick={() =>
              void markRead(
                left.map((t) => t.id),
                post('/api/notifications/read-all', {}),
              )
            }
          >
            Mark all read
          </Button>
        </SectionHeader>
        <AlertsSwitch />
        {body}
      </main>
    </div>
  );
}

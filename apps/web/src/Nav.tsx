import type { Alert } from '@joc/protocol';
import { NavBar, Toast } from '@joc/ui';
import { useEffect, useRef, useState } from 'react';
import { alertRow, pageTitle, toastable, toastText, waitingCount } from './alert-list.ts';
import { useAuth } from './auth.ts';
import {
  changeAlerts,
  useAlerts,
  useBrowserAlerts,
  useNotifications,
  useSessions,
} from './hooks.ts';
import { Updates } from './Updates.tsx';

export type Page = 'sessions' | 'inbox' | 'github' | 'history' | 'machines';

interface Props {
  page: Page;
  connected?: boolean;
  /** The session on screen, so a toast doesn't announce what the person is looking at. */
  viewing?: string;
}

/**
 * The newest alert since the page opened that wants the person, as a toast. It stays until they
 * dismiss or open it, or the alert is read (answered, or read in another tab); a newer one takes
 * its place.
 */
function useAlertToast(alerts: Alert[] | undefined, viewing: string | undefined) {
  const seen = useRef<Set<string>>(undefined);
  const [id, setId] = useState<string>();
  useEffect(() => {
    if (!alerts) return;
    if (!seen.current) {
      // What was there when the page loaded isn't news.
      seen.current = new Set(alerts.map((a) => a.id));
      return;
    }
    const [newest] = toastable(seen.current, alerts, viewing);
    if (newest) setId(newest.id);
  }, [alerts, viewing]);
  const shown = alerts?.find((a) => a.id === id && !a.read);
  return { shown, dismiss: () => setId(undefined) };
}

/** The nav bar every page shares. It also raises toasts, the tab's count and browser alerts. */
export function Nav({ page, connected, viewing }: Props) {
  const auth = useAuth();
  const notifications = useNotifications();
  const alerts = useAlerts();
  const live = useSessions();
  const threads = notifications?.state === 'reported' ? notifications.threads : undefined;
  useBrowserAlerts(threads, live.sessions, live.connected);
  const needs = live.sessions.filter((s) => s.state === 'needs').length;
  const unread = (alerts ?? []).filter((a) => !a.read).length + (threads?.length ?? 0);
  const waiting = waitingCount(needs, alerts ?? [], threads ?? []);
  const toast = useAlertToast(alerts, viewing);

  useEffect(() => {
    document.title = pageTitle(waiting);
  }, [waiting]);

  function open(alert: Alert) {
    const row = alertRow(alert);
    toast.dismiss();
    if (!row.external) return location.assign(row.href);
    // A review is read once it's opened; a session's alert reads when the session is on screen.
    void changeAlerts('read', [alert.id]);
    window.open(row.href, '_blank', 'noopener,noreferrer');
  }

  return (
    <>
      <NavBar
        items={[
          { id: 'sessions', label: 'Sessions', href: '/', needs },
          { id: 'github', label: 'GitHub', href: '/github' },
          { id: 'inbox', label: 'Inbox', href: '/inbox', count: unread || undefined },
          { id: 'history', label: 'History', href: '/history' },
          { id: 'machines', label: 'Machines', href: '/link' },
        ]}
        value={page}
        machine={connected === undefined ? undefined : connected ? 'Connected' : 'Reconnecting'}
        machineOffline={connected === false}
        user={auth.status === 'signedIn' ? auth.user?.login : undefined}
      />
      <Updates />
      {toast.shown ? (
        <div className="app-toasts">
          <Toast
            key={toast.shown.id}
            tone={toast.shown.kind === 'needs' ? 'needs' : 'neutral'}
            {...toastText(toast.shown)}
            onAction={() => toast.shown && open(toast.shown)}
            onDismiss={toast.dismiss}
          />
        </div>
      ) : null}
    </>
  );
}

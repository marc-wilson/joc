import { NavBar } from '@joc/ui';
import { useAuth } from './auth.ts';
import { useBrowserAlerts, useNotifications, useSessions } from './hooks.ts';
import { Updates } from './Updates.tsx';

export type Page = 'sessions' | 'inbox' | 'github' | 'history' | 'machines';

interface Props {
  page: Page;
  /** Sessions waiting on the person, shown on the Sessions link. */
  needs?: number;
  connected?: boolean;
}

/** The nav bar every page shares. It also raises the opt-in browser notifications. */
export function Nav({ page, needs, connected }: Props) {
  const auth = useAuth();
  const notifications = useNotifications();
  const live = useSessions();
  const threads = notifications?.state === 'reported' ? notifications.threads : undefined;
  useBrowserAlerts(threads, live.sessions, live.connected);
  return (
    <>
      <NavBar
        items={[
          { id: 'sessions', label: 'Sessions', href: '/', needs },
          { id: 'github', label: 'GitHub', href: '/github' },
          { id: 'inbox', label: 'Inbox', href: '/inbox', count: threads?.length || undefined },
          { id: 'history', label: 'History', href: '/history' },
          { id: 'machines', label: 'Machines', href: '/link' },
        ]}
        value={page}
        machine={connected === undefined ? undefined : connected ? 'Connected' : 'Reconnecting'}
        machineOffline={connected === false}
        user={auth.status === 'signedIn' ? auth.user?.login : undefined}
      />
      <Updates />
    </>
  );
}

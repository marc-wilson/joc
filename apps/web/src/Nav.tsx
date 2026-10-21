import { NavBar } from '@joc/ui';
import { useAuth } from './auth.ts';
import { useSessions } from './hooks.ts';
import { useNotificationCenter } from './Notifications.tsx';
import { Updates } from './Updates.tsx';

export type Page = 'sessions' | 'github' | 'history' | 'notifications' | 'machines' | 'settings';

interface Props {
  page: Page;
  connected?: boolean;
  /** The session on screen, so nothing announces what the person is looking at. */
  viewing?: string;
}

/**
 * The nav bar every page shares, with the notifications bell. It also raises the toasts,
 * desktop notifications and the tab's title.
 */
export function Nav({ page, connected, viewing }: Props) {
  const auth = useAuth();
  const live = useSessions();
  const needs = live.sessions.filter((s) => s.state === 'needs').length;
  const center = useNotificationCenter(viewing);

  return (
    <>
      <NavBar
        items={[
          { id: 'sessions', label: 'Sessions', href: '/', needs, pulse: center.needsArrivals },
          { id: 'github', label: 'GitHub', href: '/github' },
          { id: 'history', label: 'History', href: '/history' },
          { id: 'machines', label: 'Machines', href: '/link' },
          { id: 'settings', label: 'Settings', href: '/settings' },
        ]}
        value={page}
        notifications={center.bell}
        machine={connected === undefined ? undefined : connected ? 'Connected' : 'Reconnecting'}
        machineOffline={connected === false}
        user={auth.status === 'signedIn' ? auth.user?.login : undefined}
      />
      <Updates />
      {center.overlay}
    </>
  );
}

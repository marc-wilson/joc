import { NavBar } from '@joc/ui';
import { reconnect, signOut, useAuth } from './auth.ts';
import { GitHubConnect } from './GitHubConnect.tsx';
import { useSessions } from './hooks.ts';
import { useNotificationCenter } from './Notifications.tsx';
import { JOC_NEW_ISSUE_URL, JOC_REPO_URL } from './repo.ts';
import { Updates } from './Updates.tsx';

export type Page = 'sessions' | 'github' | 'history' | 'notifications' | 'machines' | 'settings';

interface Props {
  page: Page;
  connected?: boolean;
  /** The session on screen, so nothing announces what the person is looking at. */
  viewing?: string;
}

const go = (path: string) => location.assign(path);
/** A new tab that can't reach back into this one. */
const openInNewTab = (url: string) => window.open(url, '_blank', 'noopener,noreferrer');

/**
 * The nav bar every page shares, with the notifications bell. It also raises the toasts,
 * desktop notifications and the tab's title.
 */
export function Nav({ page, connected, viewing }: Props) {
  const auth = useAuth();
  const live = useSessions();
  const needs = live.sessions.filter((s) => s.state === 'needs').length;
  const center = useNotificationCenter(viewing);
  const github = auth.status === 'signedIn' ? auth.github : undefined;

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
        repo={{ href: JOC_REPO_URL, label: 'JOC on GitHub' }}
        machine={connected === undefined ? undefined : connected ? 'Connected' : 'Reconnecting'}
        machineOffline={connected === false}
        user={auth.status === 'signedIn' ? auth.user?.login : undefined}
        userMenu={[
          { id: 'settings', label: 'Settings', icon: 'settings', onSelect: () => go('/settings') },
          { id: 'machines', label: 'Machines', icon: 'terminal', onSelect: () => go('/link') },
          ...(github === 'reconnect'
            ? [
                {
                  id: 'reconnect',
                  label: 'Reconnect GitHub',
                  icon: 'plug' as const,
                  onSelect: reconnect,
                },
              ]
            : []),
          {
            id: 'report',
            label: 'Report a problem',
            icon: 'github',
            onSelect: () => openInNewTab(JOC_NEW_ISSUE_URL),
          },
          { id: 'signout', label: 'Sign out', onSelect: () => void signOut() },
        ]}
      />
      <GitHubConnect />
      <Updates />
      {center.overlay}
    </>
  );
}

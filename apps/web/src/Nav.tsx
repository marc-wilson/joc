import { NavBar } from '@joc/ui';
import { useAuth } from './auth.ts';

export type Page = 'sessions' | 'github' | 'history' | 'machines';

interface Props {
  page: Page;
  /** Sessions waiting on the person, shown on the Sessions link. */
  needs?: number;
  connected?: boolean;
}

/** The nav bar every page shares. */
export function Nav({ page, needs, connected }: Props) {
  const auth = useAuth();
  return (
    <NavBar
      items={[
        { id: 'sessions', label: 'Sessions', href: '/', needs },
        { id: 'github', label: 'GitHub', href: '/github' },
        { id: 'history', label: 'History', href: '/history' },
        { id: 'machines', label: 'Machines', href: '/link' },
      ]}
      value={page}
      machine={connected === undefined ? undefined : connected ? 'Connected' : 'Reconnecting'}
      machineOffline={connected === false}
      user={auth.status === 'signedIn' ? auth.user?.login : undefined}
    />
  );
}

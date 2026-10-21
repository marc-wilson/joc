import type { Ref } from 'react';
import { cx } from './cx.ts';
import { Icon } from './Icon.tsx';

export interface CountPillProps {
  count: number;
  /** Something here needs you: the pill is needs orange. Otherwise it's neutral. */
  needs?: boolean;
  /**
   * Counts arrivals: each time it goes up, the pill pulses once (a ring whose colour fades over
   * --duration-arrive; nothing under reduced motion). 0 or left out for none yet.
   */
  pulse?: number;
}

const capped = (n: number) => (n > 99 ? '99+' : String(n));

/** The count pill the bell and the nav bar's Sessions item share. Hidden at 0. */
export function CountPill({ count, needs, pulse = 0 }: CountPillProps) {
  if (!count) return null;
  return (
    // Keyed by the arrivals, so each one plays the pulse once.
    <span
      key={pulse}
      className={cx('joc-count', needs && 'is-needs', pulse > 0 && 'joc-arriving')}
      aria-hidden="true"
    >
      {capped(count)}
    </span>
  );
}

export interface NotificationBellProps {
  /** Every notification still needing you: the sessions waiting on you and unread activity. */
  unread: number;
  /** Of those, sessions waiting on you: above 0, the count is needs orange. */
  needs: number;
  open: boolean;
  onToggle: () => void;
  /** Counts arrivals, for the pill's one pulse (CountPill). */
  arrivals?: number;
  /** The panel it opens, for aria-controls. */
  controls?: string;
  buttonRef?: Ref<HTMLButtonElement>;
}

function label(unread: number, needs: number): string {
  const rest = unread - needs;
  const parts = [
    needs ? `${needs} ${needs === 1 ? 'needs' : 'need'} you` : '',
    rest ? `${rest} unread` : '',
  ].filter(Boolean);
  return parts.length ? `Notifications, ${parts.join(', ')}` : 'Notifications';
}

/** The bell in the nav bar that opens the notification panel, with its count pill. */
export function NotificationBell({
  unread,
  needs,
  open,
  onToggle,
  arrivals = 0,
  controls,
  buttonRef,
}: NotificationBellProps) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className="joc-bell"
      aria-label={label(unread, needs)}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={controls}
      title="Notifications (n)"
      onClick={onToggle}
    >
      <Icon name="bell" />
      <CountPill count={unread} needs={needs > 0} pulse={arrivals} />
    </button>
  );
}

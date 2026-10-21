import type { Ref } from 'react';
import { cx } from './cx.ts';
import { Icon } from './Icon.tsx';

export interface NotificationBellProps {
  /** Unread notifications, needs included. */
  unread: number;
  /** Sessions that need you: when above 0 the chip counts only these, in needs orange. */
  needs: number;
  open: boolean;
  onToggle: () => void;
  /**
   * Counts arrivals: each time it goes up, the chip pulses once (opacity only, and not at all
   * under reduced motion). 0 or left out for none yet.
   */
  arrivals?: number;
  /** The panel it opens, for aria-controls. */
  controls?: string;
  buttonRef?: Ref<HTMLButtonElement>;
}

const capped = (n: number) => (n > 99 ? '99+' : String(n));

function label(unread: number, needs: number): string {
  const parts = [
    needs ? `${needs} ${needs === 1 ? 'needs' : 'need'} you` : '',
    unread ? `${unread} unread` : '',
  ].filter(Boolean);
  return parts.length ? `Notifications: ${parts.join(', ')}` : 'Notifications';
}

/**
 * The bell in the nav bar that opens the notifications panel. Its chip is outlined and neutral
 * for unread notifications, and filled needs orange with a diamond, counting only those, while a
 * session needs you: form tells them apart before colour does.
 */
export function NotificationBell({
  unread,
  needs,
  open,
  onToggle,
  arrivals = 0,
  controls,
  buttonRef,
}: NotificationBellProps) {
  const count = needs || unread;
  return (
    <button
      ref={buttonRef}
      type="button"
      className={cx('jn-bell', open && 'is-open')}
      aria-label={label(unread, needs)}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={controls}
      title="Notifications (n)"
      onClick={onToggle}
    >
      <Icon name="bell" />
      {count ? (
        // Keyed by its text and the arrivals, so a new count fades in where the old one was, and
        // an arrival pulses it once.
        <span
          key={`${needs ? 'n' : 'u'}${count}:${arrivals}`}
          className={cx(
            'jn-chip',
            needs > 0 && 'jn-chip--needs',
            arrivals > 0 ? 'jn-chip--arrived' : 'joc-fade-in',
          )}
          aria-hidden="true"
        >
          {capped(count)}
        </span>
      ) : null}
    </button>
  );
}

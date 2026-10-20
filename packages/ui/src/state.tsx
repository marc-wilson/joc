import type { SessionState } from '@joc/protocol';
import { cx } from './cx.ts';

export const STATE_LABEL: Record<SessionState, string> = {
  working: 'Working',
  background: 'In background',
  needs: 'Needs you',
  idle: 'Idle',
  offline: 'Offline',
};

export interface StateDotProps {
  state?: SessionState;
  label?: string;
  /** Its machine stopped reporting: the last known state, without the live pulse. */
  quiet?: boolean;
  className?: string;
}

export function StateDot({ state = 'idle', label, quiet, className }: StateDotProps) {
  return (
    <span
      className={cx('joc-sdot', `joc-sdot--${state}`, quiet && 'is-quiet', className)}
      role="img"
      aria-label={label || STATE_LABEL[state]}
    />
  );
}

export interface StateBadgeProps {
  state?: SessionState;
  label?: string;
  count?: number;
  className?: string;
}

export function StateBadge({ state = 'idle', label, count, className }: StateBadgeProps) {
  return (
    <span className={cx('joc-sbadge', `joc-sbadge--${state}`, className)}>
      <span className={cx('joc-sdot', `joc-sdot--${state}`)} aria-hidden="true" />
      <span>{label || STATE_LABEL[state]}</span>
      {count != null ? <span className="joc-sbadge__count">{count}</span> : null}
    </span>
  );
}

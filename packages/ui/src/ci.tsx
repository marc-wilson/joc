import type { CIStatus } from '@joc/protocol';
import { cx } from './cx.ts';

const CI_LABEL: Record<CIStatus, string> = {
  pass: 'Passed',
  fail: 'Failed',
  pending: 'Pending',
  skipped: 'Skipped',
};

const CI_PATH: Record<CIStatus, string> = {
  pass: 'M3 8.5l3.2 3.2L13 4.5',
  fail: 'M4 4l8 8M12 4l-8 8',
  pending:
    'M4.5 2.5h7M4.5 13.5h7M5 2.5c0 3 6 3.5 6 5.5s-6 2.5-6 5.5M11 2.5c0 3-6 3.5-6 5.5s6 2.5 6 5.5',
  skipped: 'M3.5 8h9',
};

export interface CIMarkProps {
  status?: CIStatus;
  size?: number;
  className?: string;
}

export function CIMark({ status = 'pending', size = 14, className }: CIMarkProps) {
  return (
    <svg
      className={cx('joc-ci', `joc-ci--${status}`, className)}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={status === 'pending' ? 1.4 : 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={`CI ${CI_LABEL[status]}`}
    >
      <path d={CI_PATH[status]} />
    </svg>
  );
}

export interface CIBadgeProps {
  status?: CIStatus;
  label?: string;
  detail?: string;
}

export function CIBadge({ status = 'pending', label, detail }: CIBadgeProps) {
  return (
    <span className={cx('joc-cibadge', `joc-cibadge--${status}`)}>
      <CIMark status={status} size={12} />
      <span>{label || CI_LABEL[status]}</span>
      {detail ? <span className="joc-cibadge__detail">{detail}</span> : null}
    </span>
  );
}

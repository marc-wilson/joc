import type { CIStatus } from '@joc/protocol';
import type { ReactNode } from 'react';
import { CIMark } from './ci.tsx';
import { CopyCommand } from './code.tsx';
import { cx } from './cx.ts';
import { Branch } from './inline.tsx';

export interface HistoryRowProps {
  title: string;
  branch: string;
  ended: string;
  duration?: string;
  messages?: number;
  command: string;
  summary?: string;
  pr?: string;
}

/** A saved session with the command to resume it. */
export function HistoryRow({
  title,
  branch,
  ended,
  duration,
  messages,
  command,
  summary,
  pr,
}: HistoryRowProps) {
  return (
    <div className="joc-hist">
      <span className="joc-hist__main">
        <span className="joc-hist__title">
          {title}
          {pr ? <span className="joc-tag">{pr}</span> : null}
        </span>
        <span className="joc-hist__meta">
          <Branch>{branch}</Branch>
          <span>{ended}</span>
          <span>{duration}</span>
          <span>{messages} messages</span>
        </span>
      </span>
      {summary ? <span className="joc-hist__summary">{summary}</span> : null}
      <span className="joc-hist__cmd">
        <CopyCommand command={command} />
      </span>
    </div>
  );
}

export type SetupStatus = 'ok' | 'missing' | 'checking' | 'skipped';

const SETUP_MARK: Record<SetupStatus, CIStatus> = {
  ok: 'pass',
  missing: 'fail',
  checking: 'pending',
  skipped: 'skipped',
};

export interface SetupCheckProps {
  title: string;
  status?: SetupStatus;
  detail?: string;
  command?: string;
  children?: ReactNode;
}

/** A first-run check with the command that fixes it. */
export function SetupCheck({
  title,
  status = 'checking',
  detail,
  command,
  children,
}: SetupCheckProps) {
  return (
    <div className={cx('joc-check', `joc-check--${status}`)}>
      <span className="joc-check__lead">
        <CIMark status={SETUP_MARK[status]} size={16} />
      </span>
      <span className="joc-check__main">
        <span className="joc-check__title">{title}</span>
        {detail ? <span className="joc-check__detail">{detail}</span> : null}
        {command ? <CopyCommand command={command} /> : null}
      </span>
      {children ? <span className="joc-check__actions">{children}</span> : null}
    </div>
  );
}

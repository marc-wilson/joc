import type { CIStatus } from '@joc/protocol';
import type { ReactNode } from 'react';
import { CIMark } from './ci.tsx';
import { CopyCommand } from './code.tsx';
import { cx } from './cx.ts';
import { Branch } from './inline.tsx';
import { Checkbox } from './menu.tsx';

export interface HistoryRowProps {
  title: string;
  branch: string;
  ended: string;
  duration?: string;
  messages?: number;
  command: string;
  summary?: string;
  pr?: string;
  /** Picks the row, e.g. to delete several at once; `reason` says why it can't be picked. */
  select?: { checked: boolean; onChange: (checked: boolean) => void; reason?: string };
  /** Controls at the end of the row, e.g. an OverflowMenu. */
  actions?: ReactNode;
  /** How an action on it stands, e.g. "Deleting on harbor-mbp…": shown in the summary's place. */
  status?: ReactNode;
  /** It's gone: the row fades to this line and keeps its place, so nothing below it moves. */
  removed?: string;
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
  select,
  actions,
  status,
  removed,
}: HistoryRowProps) {
  return (
    <div
      className={cx(
        'joc-hist',
        (select !== undefined || actions !== undefined) && 'joc-hist--tools',
        removed && 'is-removed',
      )}
      aria-hidden={removed ? 'true' : undefined}
      inert={removed ? true : undefined}
    >
      {select ? (
        <span className="joc-hist__select">
          <Checkbox
            label={`Select ${title}`}
            checked={select.checked}
            disabled={!!select.reason}
            title={select.reason}
            onChange={select.onChange}
          />
        </span>
      ) : null}
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
      {status ? (
        <span className="joc-hist__summary joc-hist__status">{status}</span>
      ) : summary ? (
        <span className="joc-hist__summary">{summary}</span>
      ) : (
        <span />
      )}
      <span className="joc-hist__cmd">
        <CopyCommand command={command} />
      </span>
      {actions ? <span className="joc-hist__actions">{actions}</span> : null}
      {removed ? <span className="joc-hist__removed">{removed}</span> : null}
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

import type { CIStatus } from '@joc/protocol';
import { type ReactNode, useId } from 'react';
import { CIMark } from './ci.tsx';
import { CopyButton, CopyCommand } from './code.tsx';
import { cx } from './cx.ts';
import { Branch } from './inline.tsx';
import { Checkbox } from './menu.tsx';
import { resumeCommand, shortId, shortPath } from './resume.ts';

export interface HistoryListProps {
  children?: ReactNode;
}

/** The box History rows sit in. Rows fit its width, not the window's (container queries). */
export function HistoryList({ children }: HistoryListProps) {
  return <div className="joc-histlist">{children}</div>;
}

export interface HistoryRowProps {
  title: string;
  branch: string;
  /** The folder the session ran in; the copied command changes to it first. */
  path?: string;
  sessionId: string;
  /** When it last did something, e.g. "2h ago". */
  ended: string;
  duration?: string;
  messages?: number;
  pr?: string;
  /** Picks the row, e.g. to delete several at once; `reason` says why it can't be picked. */
  select?: { checked: boolean; onChange: (checked: boolean) => void; reason?: string };
  /** The row menu at its end, e.g. an OverflowMenu. */
  actions?: ReactNode;
  /** Resume, "Starting…", Try again or Open session: before the command, in a slot of its own. */
  resume?: ReactNode;
  /** How an action on it stands, e.g. "Deleting on harbor-mbp…": shown in the meta line's place. */
  status?: ReactNode;
  /** The status says something failed: drawn in the fail colour. */
  statusError?: boolean;
  /** It's gone: the row fades to this line and keeps its place, so nothing below it moves. */
  removed?: string;
}

/**
 * An ended session with the command to resume it. The row shows the short form,
 * `$ claude --resume <short id>`; copy and the tooltip carry the full command with its `cd`.
 * Fixed height, so a long path or title never changes the row.
 */
export function HistoryRow({
  title,
  branch,
  path,
  sessionId,
  ended,
  duration,
  messages,
  pr,
  select,
  actions,
  resume,
  status,
  statusError,
  removed,
}: HistoryRowProps) {
  const tip = useId();
  const full = resumeCommand(sessionId, path);
  const when = duration ? `${ended} · ${duration}` : ended;
  return (
    <div
      className={cx(
        'joc-hist',
        select && 'joc-hist--select',
        resume !== undefined && 'joc-hist--resume',
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
      <div className="joc-hist__main">
        <div className="joc-hist__title">
          <span className="joc-hist__title-text" title={title}>
            {title}
          </span>
          {pr ? <span className="joc-tag">{pr}</span> : null}
        </div>
        {status ? (
          <div
            className={cx('joc-hist__meta joc-hist__status', statusError && 'is-error')}
            role={statusError ? 'alert' : 'status'}
          >
            {status}
          </div>
        ) : (
          <div className="joc-hist__meta">
            {branch ? <Branch>{branch}</Branch> : null}
            {path ? (
              <code className="joc-hist__path" title={path}>
                {shortPath(path)}
              </code>
            ) : null}
            {messages !== undefined ? <span>{messages} messages</span> : null}
            <span className="joc-hist__when-inline">{when}</span>
          </div>
        )}
      </div>
      <div className="joc-hist__when">
        <time>{ended}</time>
        {duration ? <span className="joc-hist__when-sub">{duration}</span> : null}
      </div>
      {resume !== undefined ? <div className="joc-hist__act">{resume}</div> : null}
      <div className="joc-hist__cmd">
        <div className="joc-rcmd">
          <span className="joc-rcmd__prompt" aria-hidden="true">
            $
          </span>
          <code className="joc-rcmd__text">
            claude --resume <span className="joc-rcmd__id">{shortId(sessionId)}</span>
          </code>
          <span className="joc-rcmd__copy" aria-describedby={tip}>
            <CopyButton text={full} />
          </span>
        </div>
        <div className="joc-rcmd__tip" role="tooltip" id={tip}>
          <span className="joc-rcmd__tip-label">Copy puts this on your clipboard</span>
          <code className="joc-rcmd__tip-cmd">{full}</code>
        </div>
      </div>
      <div className="joc-hist__menu">{actions}</div>
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

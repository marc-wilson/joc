import type { SessionState } from '@joc/protocol';
import { CIMark } from './ci.tsx';
import { Button } from './controls.tsx';
import { cx } from './cx.ts';
import { Icon, type IconName } from './Icon.tsx';
import { SessionLink } from './session.tsx';
import { StateDot } from './state.tsx';

/**
 * What a row's mark shows: why the thread wants you. `needs` and `finished` are JOC's own alerts
 * about a session: it needed you (the needs dot while unread), or its turn ended (an outcome).
 */
export type InboxMark =
  | 'review'
  | 'mention'
  | 'ci-failed'
  | 'comment'
  | 'assign'
  | 'other'
  | 'needs'
  | 'finished';

const ICONS: Record<Exclude<InboxMark, 'ci-failed' | 'finished'>, IconName> = {
  review: 'pr',
  mention: 'at',
  comment: 'comment',
  assign: 'person',
  other: 'inbox',
  // Once read, the session may long since have moved on: no state dot then.
  needs: 'terminal',
};

function Mark({ mark, read }: { mark: InboxMark; read?: boolean }) {
  if (mark === 'ci-failed') return <CIMark status="fail" />;
  if (mark === 'finished') return <CIMark status="pass" />;
  if (mark === 'needs' && !read) return <StateDot state="needs" />;
  return <Icon name={ICONS[mark]} />;
}

export interface InboxRowProps {
  title: string;
  /** The thread's page, opened in a new tab unless `external` is false. */
  href: string;
  /** False for a page in JOC itself, opened in place. */
  external?: boolean;
  /** `repo#number`, or the repo alone. */
  reference: string;
  mark: InboxMark;
  /** What happened, e.g. "requested your review". */
  verb: string;
  updated: string;
  /** Read rows dim where they are, rather than leaving the list. */
  read?: boolean;
  session?: { title: string; state: SessionState; href?: string };
  onMarkRead?: () => void;
  /** Shows a clear button, for rows that can be removed from the list. */
  onClear?: () => void;
}

/** One GitHub notification or JOC alert: unread rows are raised with heavier text. */
export function InboxRow({
  title,
  href,
  external = true,
  reference,
  mark,
  verb,
  updated,
  read,
  session,
  onMarkRead,
  onClear,
}: InboxRowProps) {
  return (
    <div className={cx('joc-ibrow', read ? 'is-read' : 'is-unread')}>
      <span className="joc-ibrow__mark" aria-hidden="true">
        <Mark mark={mark} read={read} />
      </span>
      <div className="joc-ibrow__main">
        <div className="joc-ibrow__line1">
          {read ? null : <span className="joc-sr">Unread: </span>}
          <a
            className="joc-ibrow__title"
            href={href}
            {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
          >
            {title}
          </a>
          <span className="joc-ibrow__ref code-inline">{reference}</span>
        </div>
        <div className="joc-ibrow__meta meta">
          <span className="joc-ibrow__verb">{verb}</span>
          <span aria-hidden="true" className="joc-ibrow__sep">
            ·
          </span>
          <span className="joc-ibrow__time">{updated}</span>
        </div>
      </div>
      <div className="joc-ibrow__session">{session ? <SessionLink {...session} /> : null}</div>
      <div className={cx('joc-ibrow__action', onClear && 'has-clear')}>
        <Button
          variant="ghost"
          size="sm"
          disabled={read}
          aria-label={read ? `Read: ${title}` : `Mark read: ${title}`}
          onClick={onMarkRead}
        >
          {read ? 'Read' : 'Mark read'}
        </Button>
        {onClear ? (
          <Button
            variant="ghost"
            size="sm"
            icon="x"
            aria-label={`Clear: ${title}`}
            onClick={onClear}
          />
        ) : null}
      </div>
    </div>
  );
}

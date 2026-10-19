import type { SessionState } from '@joc/protocol';
import { CIMark } from './ci.tsx';
import { Button } from './controls.tsx';
import { cx } from './cx.ts';
import { Icon, type IconName } from './Icon.tsx';
import { SessionLink } from './session.tsx';

/** What a row's mark shows: why the thread wants you. */
export type InboxMark = 'review' | 'mention' | 'ci-failed' | 'comment' | 'assign' | 'other';

const ICONS: Record<Exclude<InboxMark, 'ci-failed'>, IconName> = {
  review: 'pr',
  mention: 'at',
  comment: 'comment',
  assign: 'person',
  other: 'inbox',
};

export interface InboxRowProps {
  title: string;
  /** The thread's page, opened in a new tab. */
  href: string;
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
}

/** One GitHub notification: unread rows are raised with heavier text, never a dot. */
export function InboxRow({
  title,
  href,
  reference,
  mark,
  verb,
  updated,
  read,
  session,
  onMarkRead,
}: InboxRowProps) {
  return (
    <div className={cx('joc-ibrow', read ? 'is-read' : 'is-unread')}>
      <span className="joc-ibrow__mark" aria-hidden="true">
        {mark === 'ci-failed' ? <CIMark status="fail" /> : <Icon name={ICONS[mark]} />}
      </span>
      <div className="joc-ibrow__main">
        <div className="joc-ibrow__line1">
          {read ? null : <span className="joc-sr">Unread: </span>}
          <a className="joc-ibrow__title" href={href} target="_blank" rel="noopener noreferrer">
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
      <div className="joc-ibrow__action">
        <Button
          variant="ghost"
          size="sm"
          disabled={read}
          aria-label={read ? `Read: ${title}` : `Mark read: ${title}`}
          onClick={onMarkRead}
        >
          {read ? 'Read' : 'Mark read'}
        </Button>
      </div>
    </div>
  );
}

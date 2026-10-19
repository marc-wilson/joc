import type { CIStatus, SessionState } from '@joc/protocol';
import { Avatar } from './Avatar.tsx';
import { CIBadge } from './ci.tsx';
import { Button } from './controls.tsx';
import { cx } from './cx.ts';
import { DiffStat } from './diff.tsx';
import { Icon } from './Icon.tsx';
import { Branch } from './inline.tsx';
import { SessionLink } from './session.tsx';

export interface PRRowProps {
  number: number;
  title: string;
  branch: string;
  author: string;
  updated: string;
  ci: CIStatus;
  ciDetail?: string;
  repo?: string;
  review?: 'Approved' | 'Changes requested' | 'Review requested';
  draft?: boolean;
  additions?: number;
  deletions?: number;
  selected?: boolean;
  session?: { title: string; state: SessionState; href?: string };
}

export function PRRow({
  number,
  title,
  branch,
  author,
  updated,
  ci,
  ciDetail,
  repo,
  review,
  draft,
  additions,
  deletions,
  selected,
  session,
}: PRRowProps) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: rows are keyboard-navigable in the PR list
    <div className={cx('joc-pr', selected && 'is-selected')} tabIndex={0}>
      <span className={cx('joc-pr__icon', draft && 'is-draft')}>
        <Icon name="pr" size={16} />
      </span>
      <span className="joc-pr__main">
        <span className="joc-pr__line1">
          <span className="joc-pr__title">{title}</span>
          {draft ? <span className="joc-tag">Draft</span> : null}
          {review ? (
            <span
              className={cx('joc-tag', `joc-tag--${review.replace(/\s+/g, '-').toLowerCase()}`)}
            >
              {review}
            </span>
          ) : null}
        </span>
        <span className="joc-pr__line2">
          <span className="joc-pr__num">
            {repo ?? ''}#{number}
          </span>
          <Branch>{branch}</Branch>
          <span className="joc-pr__author">
            <Avatar name={author} size={16} />
            {author}
          </span>
          <span>{updated}</span>
        </span>
      </span>
      <DiffStat additions={additions} deletions={deletions} />
      <span className="joc-pr__session">
        {session ? (
          <SessionLink {...session} />
        ) : (
          <Button variant="ghost" size="sm" icon="plus">
            Start session
          </Button>
        )}
      </span>
      <span className="joc-pr__ci">
        <CIBadge status={ci} detail={ciDetail} />
      </span>
    </div>
  );
}

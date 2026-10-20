import type { CIStatus, SessionState } from '@joc/protocol';
import type { ReactNode } from 'react';
import { CIMark } from './ci.tsx';
import { cx } from './cx.ts';
import { DiffStat, type FileStatus } from './diff.tsx';
import { Icon } from './Icon.tsx';
import { Branch, TextLink } from './inline.tsx';
import { StateDot } from './state.tsx';

export interface PRHeaderProps {
  title: string;
  number: number;
  /** Back to where it was opened from, e.g. "GitHub · atlas-web". */
  back?: { label: string; href: string };
  draft?: boolean;
  branch: string;
  base?: string;
  /** Who opened it and when, e.g. "priya · updated 2h ago". */
  byline?: string;
  additions?: number;
  deletions?: number;
  review?: 'Approved' | 'Changes requested' | 'Review requested';
  /** `TextLink`s at the end of the meta line, e.g. "Open on GitHub". */
  links?: ReactNode;
}

/** A pull request page's head: its title and number, then where it merges and how it stands. */
export function PRHeader({
  title,
  number,
  back,
  draft,
  branch,
  base,
  byline,
  additions,
  deletions,
  review,
  links,
}: PRHeaderProps) {
  return (
    <header className="joc-prhead">
      {back ? (
        <span className="joc-prhead__back">
          <TextLink href={back.href}>‹ {back.label}</TextLink>
        </span>
      ) : null}
      <h1 className="joc-prhead__title">
        {title} <span className="joc-prhead__num">#{number}</span>
      </h1>
      <div className="joc-prhead__meta">
        <span className={cx('joc-prhead__state', draft && 'is-draft')}>
          <Icon name="pr" size={14} />
          {draft ? 'Draft' : 'Open'}
        </span>
        <span className="joc-into">
          <Branch>{branch}</Branch>
          {base ? (
            <>
              into
              <Branch>{base}</Branch>
            </>
          ) : null}
        </span>
        {byline ? <span>{byline}</span> : null}
        {additions != null || deletions != null ? (
          <DiffStat additions={additions} deletions={deletions} />
        ) : null}
        {review ? (
          <span className={cx('joc-tag', `joc-tag--${review.replace(/\s+/g, '-').toLowerCase()}`)}>
            {review}
          </span>
        ) : null}
        {links}
      </div>
    </header>
  );
}

export interface CardProps {
  title?: string;
  count?: number;
  /** At the end of the head, e.g. a `CIBadge` or a `DiffStat`. */
  aside?: ReactNode;
  /** Names the card when it has no title. */
  label?: string;
  children?: ReactNode;
}

/** A raised card with an optional head: a title, a count and something at its end. */
export function Card({ title, count, aside, label, children }: CardProps) {
  return (
    <section className="joc-card" aria-label={label ?? title}>
      {title ? (
        <div className="joc-card__head">
          {title}
          {count != null ? <span className="joc-card__count">{count}</span> : null}
          <span className="joc-card__spacer" />
          {aside}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export interface CIRowProps {
  status: CIStatus;
  name: string;
  /** A few words after the name, e.g. "skipped on drafts". */
  detail?: string;
  /** How long it ran, e.g. "2m 10s". */
  time?: string;
}

/** One check in a pull request's Checks card. */
export function CIRow({ status, name, detail, time }: CIRowProps) {
  return (
    <div className="joc-cirow">
      <CIMark status={status} size={12} />
      <span className="joc-cirow__name">
        {name}
        {detail ? <span className="joc-cirow__detail"> · {detail}</span> : null}
      </span>
      <span className="joc-cirow__time">{time}</span>
    </div>
  );
}

const STATUS_MARK: Record<FileStatus, { mark: string; name: string }> = {
  modified: { mark: 'M', name: 'Modified' },
  added: { mark: 'A', name: 'Added' },
  deleted: { mark: 'D', name: 'Deleted' },
  renamed: { mark: 'R', name: 'Renamed' },
};

export interface ChangedFileProps {
  path: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  /** Opens the file's diff. */
  href?: string;
}

/** One changed file: its change, its path with the folder quieter, and lines added and removed. */
export function ChangedFile({ path, status, additions, deletions, href }: ChangedFileProps) {
  const cut = path.lastIndexOf('/') + 1;
  const mark = STATUS_MARK[status];
  const name = (
    <>
      <span className="joc-file__dir">{path.slice(0, cut)}</span>
      {path.slice(cut)}
    </>
  );
  return (
    <div className="joc-file">
      <span className="joc-file__status" title={mark.name}>
        {mark.mark}
      </span>
      {href ? (
        <a className="joc-file__path" href={href} title={path}>
          {name}
        </a>
      ) : (
        <span className="joc-file__path" title={path}>
          {name}
        </span>
      )}
      <span className={cx('joc-file__add', !additions && 'is-zero')}>+{additions}</span>
      <span className={cx('joc-file__del', !deletions && 'is-zero')}>−{deletions}</span>
    </div>
  );
}

export interface ReviewActionProps {
  /** The Review button. */
  children: ReactNode;
  /** Says exactly what runs and where. */
  what: ReactNode;
}

/** The PR page's one Review button, and the line under it on what it runs. */
export function ReviewAction({ children, what }: ReviewActionProps) {
  return (
    <div className="joc-review">
      <div className="joc-review__button">{children}</div>
      <p className="joc-review__what">{what}</p>
    </div>
  );
}

export interface ReviewRowProps {
  /** The session doing the review: its title and where it opens. */
  session: string;
  href?: string;
  /** The session's state while the review runs. */
  state?: SessionState;
  /** How it ended, once it has: drawn as an outcome mark, not a state. */
  result?: 'pass' | 'fail';
  /** Where it stands, e.g. "Reviewing" or "Couldn't start". */
  status?: string;
  time?: string;
}

/** A quiet line inside a card: what's missing, or what's left out. */
export function CardNote({ children }: { children?: ReactNode }) {
  return <p className="joc-card__note">{children}</p>;
}

/** One review JOC started on this pull request. */
export function ReviewRow({ session, href, state, result, status, time }: ReviewRowProps) {
  return (
    <div className="joc-revrow">
      <span className="joc-revrow__mark">
        {result ? <CIMark status={result} size={12} /> : <StateDot state={state} />}
      </span>
      <span className="joc-revrow__main">
        {href ? (
          <a className="joc-revrow__session joc-link" href={href}>
            {session}
          </a>
        ) : (
          <span className="joc-revrow__session">{session}</span>
        )}
        {status ? <span className="joc-revrow__status">{status}</span> : null}
      </span>
      <span className="joc-revrow__time">{time}</span>
    </div>
  );
}

import type { TeammateStatus } from '@joc/protocol';
import { type ReactNode, useState } from 'react';
import { CIMark } from './ci.tsx';
import { cx } from './cx.ts';
import { Icon, type IconName } from './Icon.tsx';
import { StateBadge, StateDot } from './state.tsx';

// A session's teammates: the Team tab (a list beside the selected teammate's detail), the team
// chip and nested rows in the session list, and the glance in the session header. A live
// teammate is drawn with a session state dot; how one ended is a CI mark, never a dot.

const LIVE_STATE = { working: 'working', waiting: 'idle', needs: 'needs' } as const;

const OUTCOME = { done: 'pass', failed: 'fail', stopped: 'skipped' } as const;

/** What each status reads as, on badges and to screen readers. */
export const TEAMMATE_LABEL: Record<TeammateStatus, string> = {
  working: 'Working',
  waiting: 'Waiting on lead',
  needs: 'Needs you',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
};

const isLiveStatus = (s: TeammateStatus): s is keyof typeof LIVE_STATE => s in LIVE_STATE;

/** A teammate's glyph: its state dot while live, its outcome mark once it ended. */
export function TeammateMark({ status, size = 12 }: { status: TeammateStatus; size?: number }) {
  if (isLiveStatus(status)) {
    return <StateDot state={LIVE_STATE[status]} label={TEAMMATE_LABEL[status]} />;
  }
  return <CIMark status={OUTCOME[status]} size={size} className="joc-mark" />;
}

/** A teammate's status word: a state badge while live, an outlined chip once it ended. */
export function TeammateBadge({ status }: { status: TeammateStatus }) {
  if (isLiveStatus(status)) {
    return <StateBadge state={LIVE_STATE[status]} label={TEAMMATE_LABEL[status]} />;
  }
  return (
    <span className={cx('joc-cibadge', status === 'failed' && 'joc-cibadge--fail')}>
      {TEAMMATE_LABEL[status]}
    </span>
  );
}

const issueLabel = (issue?: number) => (issue ? `#${issue}` : undefined);

export interface TeamViewProps {
  /** The teammates, e.g. `TeamGroup`s and `TeammateRow`s. */
  list: ReactNode;
  /** The selected teammate, e.g. a `TeammateDetail`. */
  detail?: ReactNode;
  /** While the pointer is over the list or focus is in it; the list holds its order meanwhile. */
  onHoldChange?: (held: boolean) => void;
}

/** The Team tab: the list of teammates, and beside it the one selected. */
export function TeamView({ list, detail, onHoldChange }: TeamViewProps) {
  return (
    <div className="joc-teamview">
      <div
        className="joc-teamview__list"
        role="listbox"
        aria-label="Teammates"
        onPointerEnter={() => onHoldChange?.(true)}
        onPointerLeave={() => onHoldChange?.(false)}
        onFocus={() => onHoldChange?.(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) onHoldChange?.(false);
        }}
      >
        {list}
      </div>
      <section className="joc-teamview__detail" aria-label="Teammate detail">
        {detail}
      </section>
    </div>
  );
}

/** "Active 3", "Finished 2" over the teammates in the list. */
export function TeamGroup({ title, count }: { title: string; count: number }) {
  return (
    <div className="joc-mategroup">
      {title} <span className="joc-mategroup__count">{count}</span>
    </div>
  );
}

export interface TeammateRowProps {
  status: TeammateStatus;
  title: string;
  issue?: number;
  /** The second line: what it does now, what it asks, its branch, or how it ended. */
  step?: string;
  /** Its pull request, after the second line, with its CI outcome. */
  pr?: { number: number; ci?: 'pass' | 'fail' | 'pending' };
  elapsed?: string;
  selected?: boolean;
  /** It just took a new place in the list: it fades in there. */
  moved?: boolean;
  onSelect?: () => void;
}

/** One teammate in the Team tab's list: fixed height, its text replaced in place. */
export function TeammateRow({
  status,
  title,
  issue,
  step,
  pr,
  elapsed,
  selected,
  moved,
  onSelect,
}: TeammateRowProps) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={!!selected}
      className={cx(
        'joc-mate',
        `joc-mate--${status}`,
        selected && 'is-selected',
        moved && 'is-moved',
      )}
      onClick={onSelect}
    >
      <span className="joc-mate__glyph">
        <TeammateMark status={status} />
      </span>
      <span className="joc-mate__main">
        <span className="joc-mate__line1">
          <span className="joc-mate__title">{title}</span>
          {issue ? <span className="joc-mate__issue">{issueLabel(issue)}</span> : null}
          <TeammateBadge status={status} />
        </span>
        <span className="joc-mate__line2">
          <span className="joc-mate__step joc-fade-in" key={step}>
            {step}
          </span>
          {pr ? (
            <span className="joc-mate__pr">
              <Icon name="pr" size={12} />#{pr.number}
              {pr.ci ? <CIMark status={pr.ci} size={12} className="joc-mark" /> : null}
            </span>
          ) : null}
        </span>
      </span>
      <span className="joc-mate__aside">
        <span className="joc-mate__elapsed">{elapsed}</span>
      </span>
    </button>
  );
}

export interface TeammateDetailProps {
  status: TeammateStatus;
  title: string;
  issue?: number;
  elapsed?: string;
  /** Buttons at the right of the title, e.g. "Open PR #486". */
  actions?: ReactNode;
  /** The line under the title: its branch, worktree, when it started or finished. */
  meta?: ReactNode;
  /** Its sections, e.g. `TeamSection`s. */
  children?: ReactNode;
}

/** One teammate, opened beside the list: its title and status, then its sections. */
export function TeammateDetail({
  status,
  title,
  issue,
  elapsed,
  actions,
  meta,
  children,
}: TeammateDetailProps) {
  return (
    <div className="joc-matedetail">
      <div className="joc-matedetail__head">
        <div className="joc-matedetail__top">
          <TeammateMark status={status} />
          <h2 className="joc-matedetail__title">{title}</h2>
          {issue ? <span className="joc-mate__issue">{issueLabel(issue)}</span> : null}
          <TeammateBadge status={status} />
          {elapsed ? <span className="joc-mate__elapsed">{elapsed}</span> : null}
          {actions ? <div className="joc-matedetail__actions">{actions}</div> : null}
        </div>
        {meta ? <div className="joc-matedetail__meta">{meta}</div> : null}
      </div>
      {children}
    </div>
  );
}

/** A branch or worktree in the detail's meta line, mono with its icon. */
export function TeammatePath({ icon, children }: { icon: 'branch' | 'folder'; children: string }) {
  return (
    <span className="joc-matedetail__path">
      <Icon name={icon} size={12} />
      {children}
    </span>
  );
}

export interface TeamSectionProps {
  title: string;
  count?: number;
  /** At the right of the title, e.g. the time a report came. */
  aside?: ReactNode;
  children?: ReactNode;
}

/** One part of a teammate's detail: "Report", "Links", "Brief", "Steps", "Messages". */
export function TeamSection({ title, count, aside, children }: TeamSectionProps) {
  return (
    <section className="joc-matesec" aria-label={title}>
      <div className="joc-matesec__head">
        {title}
        {count != null ? <span className="joc-matesec__count">{count}</span> : null}
        {aside ? <span className="joc-matesec__aside joc-mmsg__time">{aside}</span> : null}
      </div>
      {children}
    </section>
  );
}

/** What the session asked the teammate: four lines until opened. */
export function TeammateBrief({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  // Short briefs fit their four lines; only a longer one gets the toggle.
  const long = text.length > 280 || text.split('\n').length > 4;
  return (
    <div className={cx('joc-brief', open && 'is-open')}>
      <p className="joc-brief__text">{text}</p>
      {long ? (
        <button
          type="button"
          className="joc-brief__more"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Show less' : 'Show full brief'}
        </button>
      ) : null}
    </div>
  );
}

export interface TeammateStep {
  id: string;
  /** The tool and what it worked on, e.g. "Edit apps/web/src/draft-store.ts". */
  text: string;
  /** When it started, on the teammate's clock. */
  time?: string;
  status: 'done' | 'fail' | 'current';
}

/** A teammate's latest steps, with the earlier ones counted in one row above them. */
export function TeammateSteps({ steps, earlier = 0 }: { steps: TeammateStep[]; earlier?: number }) {
  return (
    <div className="joc-msteps">
      {earlier ? (
        <div className="joc-msteps__more">
          {earlier} earlier {earlier === 1 ? 'step' : 'steps'}
        </div>
      ) : null}
      {steps.map((s) => (
        <div
          key={s.id}
          className={cx(
            'joc-mstep',
            s.status === 'current' && 'is-current',
            s.status === 'fail' && 'is-failed',
          )}
        >
          <span className="joc-mstep__lead">
            {s.status === 'current' ? (
              <StateDot state="working" label="Running" />
            ) : (
              <CIMark
                status={s.status === 'fail' ? 'fail' : 'pass'}
                size={12}
                className="joc-mark"
              />
            )}
          </span>
          <span className="joc-mstep__text">{s.text}</span>
          <span className="joc-mstep__time">{s.time}</span>
        </div>
      ))}
    </div>
  );
}

export interface TeamMessageProps {
  /** The session's message to the teammate, or the teammate's to the session. */
  from: 'lead' | 'mate';
  /** Who wrote it: "Lead", or the teammate's issue or name. */
  who: string;
  /** Who it went to, e.g. "to #81", "to lead". */
  to: string;
  time?: string;
  children?: ReactNode;
}

/** The messages between the session and a teammate, oldest first. */
export function TeamMessages({ children }: { children?: ReactNode }) {
  return <div className="joc-mthread">{children}</div>;
}

/** One message between the session and a teammate. */
export function TeamMessage({ from, who, to, time, children }: TeamMessageProps) {
  return (
    <div className={cx('joc-mmsg', `joc-mmsg--${from}`)}>
      <div className="joc-mmsg__head">
        <span className="joc-mmsg__who">{who}</span>
        <span className="joc-mmsg__dir">{to}</span>
        {time ? <span className="joc-mmsg__time">{time}</span> : null}
      </div>
      <div className="joc-mmsg__body">{children}</div>
    </div>
  );
}

export interface TeammateReportProps {
  /** How it ended; a failed report has the fail colour's border. */
  status: 'done' | 'failed' | 'stopped';
  /** The report's first line. */
  headline: string;
  /** The rest of it. */
  children?: ReactNode;
}

/** A teammate's final report: its first line as a head, the rest under it. */
export function TeammateReport({ status, headline, children }: TeammateReportProps) {
  return (
    <div className={cx('joc-report', status === 'failed' && 'joc-report--failed')}>
      <div className="joc-report__head">
        <TeammateMark status={status} />
        {headline}
      </div>
      {children ? <div className="joc-report__body">{children}</div> : null}
    </div>
  );
}

/** Where a live teammate's report will go. */
export function TeammatePending({ children }: { children?: ReactNode }) {
  return <div className="joc-report-slot">{children}</div>;
}

/** The links out of a teammate: its pull request, branch and worktree. */
export function TeammateLinks({ children }: { children?: ReactNode }) {
  return <div className="joc-matelinks">{children}</div>;
}

export interface TeammateLinkProps {
  icon: IconName;
  /** The mono part: a PR number, a branch, a path. */
  label: string;
  /** A quieter part after it, e.g. the PR's title. */
  sub?: ReactNode;
  /** A mark at its end, e.g. its CI outcome. */
  end?: ReactNode;
  href?: string;
  /** Copies the label instead of following a link, e.g. for a worktree's path. */
  onClick?: () => void;
  title?: string;
}

/** One link out of a teammate. Without `href` it's a button, e.g. one that copies a path. */
export function TeammateLink({ icon, label, sub, end, href, onClick, title }: TeammateLinkProps) {
  const content = (
    <>
      <Icon name={icon} size={14} />
      <span className="joc-matelink__mono">{label}</span>
      {sub ? <span className="joc-matelink__sub">{sub}</span> : null}
      {end}
    </>
  );
  return href ? (
    <a className="joc-matelink" href={href} target="_blank" rel="noreferrer" title={title}>
      {content}
    </a>
  ) : (
    <button type="button" className="joc-matelink" onClick={onClick} title={title}>
      {content}
    </button>
  );
}

/** Screenshots a teammate's report shows, as a grid of frames. */
export function TeammateShots({ children }: { children?: ReactNode }) {
  return <div className="joc-shots">{children}</div>;
}

export interface TeamChipProps {
  /** Teammates still at work. */
  active: number;
  total: number;
  failed?: number;
}

/** The session row's team chip: "3/6", and a cross with how many failed. */
export function TeamChip({ active, total, failed = 0 }: TeamChipProps) {
  const label = `${active} of ${total} teammates active${failed ? `, ${failed} failed` : ''}`;
  return (
    <span className="joc-teamchip" title={label} role="img" aria-label={label}>
      <Icon name="team" size={12} />
      {active}
      <span className="joc-teamchip__sep">/</span>
      {total}
      {failed ? (
        <>
          <span className="joc-teamchip__sep">·</span>
          <span className="joc-teamchip__fail">✕{failed}</span>
        </>
      ) : null}
    </span>
  );
}

export interface SessionTeammatesProps {
  children?: ReactNode;
  /** A last row, e.g. "+1 stopped · open Team". */
  more?: { label: string; onClick: () => void };
}

/** A session's teammates under its row in the session list, while you keep them open. */
export function SessionTeammates({ children, more }: SessionTeammatesProps) {
  return (
    <div className="joc-smates">
      {children}
      {more ? (
        <button type="button" className="joc-smates__more" onClick={more.onClick}>
          {more.label}
        </button>
      ) : null}
    </div>
  );
}

export interface SessionTeammateProps {
  status: TeammateStatus;
  title: string;
  issue?: number;
  time?: string;
  onSelect?: () => void;
}

/** One teammate under its session's row: dense, it opens the teammate in the Team tab. */
export function SessionTeammate({ status, title, issue, time, onSelect }: SessionTeammateProps) {
  return (
    <button
      type="button"
      className={cx('joc-smate', `joc-smate--${status}`)}
      onClick={onSelect}
      title={`${title}: ${TEAMMATE_LABEL[status]}`}
    >
      <TeammateMark status={status} />
      <span className="joc-smate__title">{title}</span>
      <span className="joc-smate__issue">{issueLabel(issue)}</span>
      <span className="joc-smate__time">{time}</span>
    </button>
  );
}

export interface TeamGlanceProps {
  /** Every teammate's status, newest start first. */
  statuses: TeammateStatus[];
  onClick?: () => void;
}

/** The most dots the glance shows; more live teammates read as "+N". */
const GLANCE_DOTS = 5;

/**
 * The session header's glance at its team, e.g. "3 teammates · 1 done": a dot per live teammate
 * (up to five), then words. It opens the Team tab. Nothing while there are none.
 */
export function TeamGlance({ statuses, onClick }: TeamGlanceProps) {
  if (!statuses.length) return null;
  const count = (s: TeammateStatus) => statuses.filter((t) => t === s).length;
  const live = statuses.filter(isLiveStatus);
  const [needs, waiting, done, failed] = [
    count('needs'),
    count('waiting'),
    count('done'),
    count('failed'),
  ];
  const allDone = !live.length && done === statuses.length;
  const total = `${statuses.length} ${statuses.length === 1 ? 'teammate' : 'teammates'}`;
  const words = allDone
    ? 'all done'
    : needs
      ? `${needs} needs you`
      : waiting
        ? `${waiting} waiting on lead`
        : done
          ? `${done} done`
          : undefined;
  // Needs you first, so the one loud dot leads.
  const dots = [...live].sort((a, b) => Number(b === 'needs') - Number(a === 'needs'));
  const label = [total, words, failed ? `${failed} failed` : undefined].filter(Boolean).join(', ');
  return (
    <button
      type="button"
      className={cx('joc-teamsum', needs > 0 && 'joc-teamsum--needs')}
      onClick={onClick}
      aria-label={`${label}. Open Team`}
    >
      {allDone ? (
        <CIMark status="pass" size={12} className="joc-mark" />
      ) : dots.length ? (
        <span className="joc-teamsum__dots" aria-hidden="true">
          {dots.slice(0, GLANCE_DOTS).map((s, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the dots have no identity of their own
            <span key={i} className={cx('joc-sdot', `joc-sdot--${LIVE_STATE[s]}`)} />
          ))}
          {dots.length > GLANCE_DOTS ? (
            <span className="joc-teamsum__num">+{dots.length - GLANCE_DOTS}</span>
          ) : null}
        </span>
      ) : null}
      <span>
        <span className="joc-teamsum__num">{statuses.length}</span>{' '}
        {statuses.length === 1 ? 'teammate' : 'teammates'}
        {words ? (
          <>
            {' '}
            <span className="joc-teamsum__sep">·</span>{' '}
            {allDone ? (
              words
            ) : (
              <>
                <span className="joc-teamsum__num">{words.split(' ')[0]}</span>{' '}
                {words.split(' ').slice(1).join(' ')}
              </>
            )}
          </>
        ) : null}
      </span>
      {failed ? (
        <>
          <span className="joc-teamsum__sep">·</span>
          <span className="joc-teamsum__fail">
            <CIMark status="fail" size={12} className="joc-mark" />
            {failed}
          </span>
        </>
      ) : null}
    </button>
  );
}

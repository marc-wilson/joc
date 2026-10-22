import type { CIStatus, SessionState } from '@joc/protocol';
import {
  type FocusEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Avatar } from './Avatar.tsx';
import { CIBadge, CIMark } from './ci.tsx';
import { cx } from './cx.ts';
import { Icon, type IconName } from './Icon.tsx';
import { Branch } from './inline.tsx';
import { type FitPiece, fitPieces } from './ops-fit.ts';
import { RepoGroupHeader } from './session.tsx';
import { STATE_LABEL, StateBadge, StateDot } from './state.tsx';

// Operations (#111): one row per piece of work, each stage a cell that links to where it's
// looked at. Full at desktop widths, the stages folded into one pipeline cell when narrower,
// one link per row on a phone.

export type OperationsLayout = 'full' | 'compact' | 'phone';

/** Fixed stage columns at full width, after Work (1fr) and before Deployed. */
const FULL_COLUMNS = '248px 132px 148px 176px 104px';
const DEPLOYED_COLUMN = '128px';

/** The grid of a header or row in this layout. */
export function operationsColumns(layout: OperationsLayout, deployed: boolean): string {
  if (layout === 'compact') return 'minmax(0, 1fr) 232px minmax(0, 1.15fr)';
  return `minmax(0, 1fr) ${FULL_COLUMNS}${deployed ? ` ${DEPLOYED_COLUMN}` : ''}`;
}

/** The narrowest Work column the full layout allows before it folds into the pipeline. */
export const OPERATIONS_MIN_WORK = 240;

/** How wide the full layout's fixed columns, gaps and padding are. */
export function operationsFixedWidth(deployed: boolean): number {
  const fixed = [248, 132, 148, 176, 104, ...(deployed ? [128] : [])];
  return fixed.reduce((a, b) => a + b, 0) + fixed.length * 16 + 24 + 2;
}

/** Where a cell goes: a page in JOC, GitHub in a new tab, or an action here. */
export interface OpLink {
  /** Its destination in words, for the tooltip and screen readers: "Open the lint log". */
  label: string;
  href?: string;
  /** Opens GitHub (or anywhere outside JOC) in a new tab. */
  external?: boolean;
  onClick?: () => void;
}

/** The destination, named once the pointer has rested on a cell for a moment. */
const TIP_DELAY_MS = 500;

function Cell({ link, children }: { link?: OpLink; children: ReactNode }) {
  const [tip, setTip] = useState<{ left: number; top: number; below: boolean }>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!link) {
    return (
      <span className="joc-opcell" aria-hidden={children ? undefined : true}>
        {children}
      </span>
    );
  }
  const show = (e: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      // Above the cell, unless it's at the top edge: never over the cell itself.
      const below = r.top < 56;
      setTip({ left: r.left, top: below ? r.bottom + 6 : r.top - 6, below });
    }, TIP_DELAY_MS);
  };
  const hide = () => {
    clearTimeout(timer.current);
    setTip(undefined);
  };
  const tooltip = tip ? (
    <span
      role="tooltip"
      className="joc-op-tip"
      style={{
        left: tip.left,
        top: tip.top,
        transform: tip.below ? undefined : 'translateY(-100%)',
      }}
    >
      <span>{link.label}</span>
      {link.external ? <span className="joc-op-ter">GitHub, new tab</span> : null}
    </span>
  ) : null;
  const events = { onMouseEnter: show, onMouseLeave: hide, onBlur: hide };
  if (link.onClick && !link.href) {
    return (
      <button
        type="button"
        className="joc-opcell joc-opcell--button"
        aria-label={link.label}
        onClick={link.onClick}
        {...events}
      >
        {children}
        {tooltip}
      </button>
    );
  }
  return (
    <a
      className="joc-opcell"
      href={link.href}
      aria-label={link.label}
      onClick={link.onClick}
      {...(link.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      {...events}
    >
      {children}
      {tooltip}
    </a>
  );
}

/** Text that fades in when it changes, in place. */
function Live({ text, className }: { text?: string; className?: string }) {
  return (
    <span key={text} className={cx('joc-op-trunc', 'joc-fade-in', className)}>
      {text}
    </span>
  );
}

/** One stage of the compact pipeline: a glyph and a few words. */
export interface OpPiece extends FitPiece {
  icon?: IconName;
  ci?: CIStatus;
  /** A state dot: only merge conflicts, which need you, use one (the needs diamond). */
  dot?: SessionState;
  tone?: 'muted' | 'fail';
}

function Pipeline({ pieces, lines }: { pieces: OpPiece[]; lines: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(() => setWidth(el.clientWidth));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const { kept, dropped } = fitPieces(pieces, width, lines);
  return (
    <span ref={ref} className={cx('joc-op-pieces', lines > 1 && 'is-wrap')}>
      {kept.map((p) => (
        <span
          key={p.text}
          className={cx(
            'joc-op-piece',
            p.tone === 'muted' && 'is-muted',
            p.tone === 'fail' && 'is-fail',
          )}
        >
          {p.dot ? (
            <StateDot state={p.dot} />
          ) : p.ci ? (
            <CIMark status={p.ci} size={12} />
          ) : p.icon ? (
            <Icon name={p.icon} size={12} />
          ) : null}
          <span>{p.text}</span>
        </span>
      ))}
      {dropped.length ? (
        <span className="joc-op-tag" title={dropped.map((p) => p.text).join(', ')}>
          +{dropped.length}
        </span>
      ) : null}
    </span>
  );
}

export interface OperationRowProps {
  layout: OperationsLayout;
  /** The Deployed column is on screen. */
  deployed?: boolean;
  title: string;
  branch?: string;
  /** After the branch: "2m", "by harbor-bot · 1h", "atlas-web · 1h". */
  meta: string;
  /** The phone row's age, top right. */
  age: string;
  /** Why it needs you, as its pill says: "Answer Claude", "Fix CI", ... */
  needs?: string;
  /** Shipped: a quieter title. */
  done?: boolean;
  work: OpLink;
  /** Its session; without one, `start` offers to start one on its branch. */
  claude?: { state: SessionState; activity?: string; quiet?: boolean; link: OpLink };
  start?: OpLink;
  pr?: {
    number: number;
    state: 'open' | 'draft' | 'closed' | 'merged';
    additions: number;
    deletions: number;
    link: OpLink;
  };
  ci?: { status: CIStatus; detail?: string; note: string; link: OpLink };
  review?: {
    kind: 'approved' | 'changes' | 'required' | 'commented';
    people: { name: string; src?: string }[];
    note: string;
    link: OpLink;
  };
  merged?:
    | { kind: 'merged'; when: string; link: OpLink }
    | { kind: 'conflicts'; note: string; link: OpLink };
  deploy?: { status: CIStatus; environment: string; note: string; link: OpLink };
  /** Said in the Deployed cell when there is no deploy, e.g. "No deploys reported". */
  deployNote?: string;
  /** The stages for the compact and phone layouts, in order. */
  pieces: OpPiece[];
  /** Where the compact pipeline cell goes. */
  pipeline: OpLink;
}

const PR_WORD = { open: 'Open', draft: 'Draft', closed: 'Closed', merged: 'Merged' } as const;
const REVIEW_WORD = {
  approved: 'Approved',
  changes: 'Changes requested',
  required: 'Review required',
  commented: 'Commented',
} as const;

/** One piece of work: a session, a pull request, or both. */
export function OperationRow(props: OperationRowProps) {
  const { layout, title, branch, meta, needs, done, claude, start } = props;
  const rowCls = cx('joc-oprow', needs && 'is-needs', done && 'is-done');
  const pill = needs ? <StateBadge state="needs" label={needs} /> : null;

  if (layout === 'phone') {
    return (
      <a
        className={cx(rowCls, 'joc-oprow--phone')}
        href={props.work.href}
        aria-label={props.work.label}
        {...(props.work.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      >
        <span className="joc-opcell__l1">
          <span className="joc-oprow__title joc-op-trunc">{title}</span>
          <span className="joc-op-ter joc-op-num joc-op-small">{props.age}</span>
        </span>
        <span className="joc-opcell__l2">
          {claude ? (
            <>
              <StateDot state={claude.state} quiet={claude.quiet} />
              <Live text={claude.activity} className="joc-op-sec" />
            </>
          ) : (
            <span className="joc-op-ter joc-op-trunc">No session · pull request only</span>
          )}
          <span className="joc-op-grow" />
          {pill}
        </span>
        <Pipeline pieces={props.pieces} lines={1} />
      </a>
    );
  }

  const work = (
    <Cell link={props.work}>
      <span className="joc-opcell__l1">
        <span className="joc-oprow__title joc-op-trunc">{title}</span>
      </span>
      <span className="joc-opcell__l2">
        {branch ? (
          <span className="joc-op-branch">
            <Branch>{branch}</Branch>
          </span>
        ) : null}
        <span className="joc-op-num">{branch ? `· ${meta}` : meta}</span>
        {pill}
      </span>
    </Cell>
  );

  const claudeCell = claude ? (
    claude.state === 'needs' ? (
      <Cell link={claude.link}>
        <span className="joc-opcell__l1">
          <StateDot state="needs" />
          <Live text={claude.activity ?? STATE_LABEL.needs} className="joc-op-pri" />
        </span>
      </Cell>
    ) : (
      <Cell link={claude.link}>
        <span className="joc-opcell__l1">
          <StateDot state={claude.state} quiet={claude.quiet} />
          <span className="joc-op-sec">{STATE_LABEL[claude.state]}</span>
        </span>
        <span className="joc-opcell__l2">
          <Live text={claude.activity} className="joc-op-sec" />
        </span>
      </Cell>
    )
  ) : (
    <Cell link={start}>
      <span className="joc-opcell__l1 joc-op-ter">No session</span>
      {start ? (
        <span className="joc-opcell__l2">
          <span className="joc-op-link">Start session</span>
        </span>
      ) : null}
    </Cell>
  );

  if (layout === 'compact') {
    return (
      <div className={rowCls} style={{ gridTemplateColumns: operationsColumns('compact', false) }}>
        {work}
        {claudeCell}
        <Cell link={props.pipeline}>
          <Pipeline pieces={props.pieces} lines={2} />
        </Cell>
      </div>
    );
  }

  const { pr, ci, review, merged, deploy } = props;
  return (
    <div
      className={rowCls}
      style={{ gridTemplateColumns: operationsColumns('full', !!props.deployed) }}
    >
      {work}
      {claudeCell}
      {pr ? (
        <Cell link={pr.link}>
          <span className="joc-opcell__l1">
            <span
              className={cx(
                'joc-op-icon',
                (pr.state === 'draft' || pr.state === 'closed') && 'is-muted',
              )}
            >
              <Icon name="pr" size={14} />
            </span>
            <span className="joc-op-mono joc-op-pri">#{pr.number}</span>
            <span className="joc-tag">{PR_WORD[pr.state]}</span>
          </span>
          <span className="joc-opcell__l2">
            <span className="joc-op-mono joc-add">+{pr.additions}</span>
            <span className="joc-op-mono joc-del">−{pr.deletions}</span>
            {pr.state === 'closed' ? <span>not merged</span> : null}
          </span>
        </Cell>
      ) : (
        <Cell>{null}</Cell>
      )}
      {ci ? (
        <Cell link={ci.link}>
          <span className="joc-opcell__l1">
            <CIBadge status={ci.status} detail={ci.detail} />
          </span>
          <span className="joc-opcell__l2">
            <Live text={ci.note} />
          </span>
        </Cell>
      ) : (
        <Cell>{null}</Cell>
      )}
      {review ? (
        <Cell link={review.link}>
          <span className="joc-opcell__l1">
            <span className={cx('joc-tag', review.kind === 'approved' && 'joc-tag--approved')}>
              {REVIEW_WORD[review.kind]}
            </span>
          </span>
          <span className="joc-opcell__l2">
            {review.people.length ? (
              <span className="joc-op-avs">
                {review.people.slice(0, 3).map((p) => (
                  <Avatar key={p.name} name={p.name} src={p.src} size={16} />
                ))}
              </span>
            ) : null}
            <span className="joc-op-trunc">{review.note}</span>
          </span>
        </Cell>
      ) : (
        <Cell>{null}</Cell>
      )}
      {merged ? (
        <Cell link={merged.link}>
          {merged.kind === 'merged' ? (
            <>
              <span className="joc-opcell__l1">
                <span className="joc-op-icon">
                  <Icon name="check" size={14} />
                </span>
                <span className="joc-op-sec">Merged</span>
              </span>
              <span className="joc-opcell__l2">
                <span className="joc-op-num">{merged.when}</span>
              </span>
            </>
          ) : (
            <>
              <span className="joc-opcell__l1">
                <StateDot state="needs" label="Conflicts" />
                <span className="joc-op-needs">Conflicts</span>
              </span>
              <span className="joc-opcell__l2">
                <span className="joc-op-trunc">{merged.note}</span>
              </span>
            </>
          )}
        </Cell>
      ) : (
        <Cell>{null}</Cell>
      )}
      {props.deployed ? (
        deploy ? (
          <Cell link={deploy.link}>
            <span className="joc-opcell__l1">
              {deploy.status === 'pass' ? (
                <span className="joc-op-icon">
                  <Icon name="check" size={14} />
                </span>
              ) : (
                <CIMark status={deploy.status} size={14} />
              )}
              <span className={deploy.status === 'fail' ? 'joc-op-fail' : 'joc-op-sec'}>
                {deploy.status === 'pass'
                  ? deploy.environment
                  : deploy.status === 'fail'
                    ? 'Failed'
                    : 'Deploying'}
              </span>
            </span>
            <span className="joc-opcell__l2">
              <Live text={deploy.note} />
            </span>
          </Cell>
        ) : props.deployNote ? (
          <Cell>
            <span className="joc-opcell__l2">{props.deployNote}</span>
          </Cell>
        ) : (
          <Cell>{null}</Cell>
        )
      ) : null}
    </div>
  );
}

export interface OperationsHeadProps {
  layout: OperationsLayout;
  deployed?: boolean;
  /** Said after the stage names, e.g. "Filled in from GitHub after you connect". */
  note?: string;
}

/** The column names over the rows. */
export function OperationsHead({ layout, deployed, note }: OperationsHeadProps) {
  if (layout === 'phone') return null;
  const stages = ['PR', 'CI', 'Review', 'Merged', ...(deployed ? ['Deployed'] : [])];
  const folded = layout === 'compact' || note;
  return (
    <div
      className="joc-ops__colhead"
      style={{ gridTemplateColumns: operationsColumns(layout, !!deployed) }}
    >
      <span>Work</span>
      <span>Claude</span>
      {folded ? (
        <span className={layout === 'full' ? 'joc-op-span' : undefined}>
          {stages.join(' · ')}
          {note ? <span className="joc-ops__colnote">{note}</span> : null}
        </span>
      ) : (
        stages.map((s) => <span key={s}>{s}</span>)
      )}
    </div>
  );
}

export interface OperationsGroupProps {
  repo: string;
  /** "7 in flight", "2 today". */
  count: string;
  /** How many of its rows need you, over the whole group. */
  needs?: number;
  collapsed?: boolean;
  onToggle?: () => void;
  /** Said at the header's end once, e.g. "No deploys reported". */
  note?: string;
  /** The note lines up with this column's width at full layout. */
  noteWidth?: number;
}

/** A repo group's header, or Shipped's. */
export function OperationsGroup({
  repo,
  count,
  needs,
  collapsed,
  onToggle,
  note,
  noteWidth,
}: OperationsGroupProps) {
  return (
    <div className="joc-ops__group">
      <RepoGroupHeader
        repo={repo}
        count={count}
        needs={needs}
        needsLabel={needs ? `${needs} needs you` : undefined}
        collapsed={collapsed}
        onToggle={onToggle}
      />
      {note ? (
        <span className="joc-ops__groupnote" style={noteWidth ? { width: noteWidth } : undefined}>
          {note}
        </span>
      ) : null}
    </div>
  );
}

export interface OperationsConnectProps {
  title: string;
  body: string;
  action?: ReactNode;
}

/** First run: GitHub doesn't reach JOC yet, so only the sessions show. */
export function OperationsConnect({ title, body, action }: OperationsConnectProps) {
  return (
    <div className="joc-ops-connect">
      <span className="joc-op-icon">
        <Icon name="github" size={16} />
      </span>
      <div className="joc-ops-connect__text">
        <span className="joc-ops-connect__title">{title}</span>
        <span className="joc-ops-connect__body">{body}</span>
      </div>
      {action}
    </div>
  );
}

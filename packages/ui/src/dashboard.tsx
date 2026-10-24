import type { CIStatus, SessionState } from '@joc/protocol';
import { Fragment, type ReactNode } from 'react';
import { CIMark } from './ci.tsx';
import { cx } from './cx.ts';
import { Icon, type IconName } from './Icon.tsx';
import type { OpLink } from './operations.tsx';
import { STATE_LABEL, StateBadge, StateDot } from './state.tsx';

// The Operations dashboard (#114): a KPI strip over panels (pipeline, what needs you, live
// activity, machines, repos, throughput). Every number opens the table filtered to the work
// behind it, so tiles, stages, repos and machines are buttons that say whether they're selected.

/** Where a piece of work stands, furthest first reached: the pipeline's stages. */
export type DashStageId = 'session' | 'pr' | 'review' | 'merged' | 'deployed';

export interface DashKpiProps {
  label: string;
  /** The number; undefined shows an em dash, for a tile that needs GitHub. */
  value?: number;
  sub: string;
  /** The Needs you tile: it leads, and turns orange above 0. */
  lead?: boolean;
  needs?: boolean;
  selected?: boolean;
  /** Waits on GitHub: not a link. */
  off?: boolean;
  ariaLabel: string;
  onSelect?: () => void;
}

export function DashKpi({
  label,
  value,
  sub,
  lead,
  needs,
  selected,
  off,
  ariaLabel,
  onSelect,
}: DashKpiProps) {
  const cls = cx(
    'joc-dash-kpi',
    lead && 'is-lead',
    needs && 'is-needs',
    selected && 'is-selected',
    off && 'is-off',
  );
  const inside = (
    <>
      <span className="joc-dash-kpi__label">{label}</span>
      <span className="joc-dash-kpi__num">{value ?? '—'}</span>
      <span className="joc-dash-kpi__sub">{sub}</span>
    </>
  );
  if (off) {
    return (
      <div className={cls} title={ariaLabel}>
        {inside}
      </div>
    );
  }
  return (
    <button
      type="button"
      className={cls}
      aria-pressed={!!selected}
      aria-label={ariaLabel}
      onClick={onSelect}
    >
      {inside}
    </button>
  );
}

export function DashKpis({ children }: { children: ReactNode }) {
  return <div className="joc-dash-kpis">{children}</div>;
}

export interface DashPanelProps {
  /** Which panel, for its place in the grid. */
  area: 'pipe' | 'needs' | 'feed' | 'machines' | 'repos' | 'throughput';
  title: string;
  /** Said after the title: a count, a scope. */
  count?: string;
  /** Right of the header: a note, a link. */
  aside?: ReactNode;
  /** The 40px footer: a line, and one link. */
  footer?: ReactNode;
  children: ReactNode;
}

export function DashPanel({ area, title, count, aside, footer, children }: DashPanelProps) {
  const id = `joc-dash-${area}`;
  return (
    <section className={cx('joc-dash-panel', `is-${area}`)} aria-labelledby={id}>
      <header className="joc-dash-ph">
        <h2 className="joc-dash-pt" id={id}>
          {title}
        </h2>
        {count ? <span className="joc-dash-pc">{count}</span> : null}
        {aside ? <div className="joc-dash-ph__right">{aside}</div> : null}
      </header>
      {children}
      {footer ? <div className="joc-dash-pf">{footer}</div> : null}
    </section>
  );
}

/** A panel's quiet note, as its header or footer says it. */
export function DashNote({ children }: { children: ReactNode }) {
  return <span className="joc-dash-pc">{children}</span>;
}

/** A panel's link: a button for an action here, an anchor for a page. */
export function DashLink({ link, children }: { link: OpLink; children: ReactNode }) {
  if (link.onClick && !link.href) {
    return (
      <button
        type="button"
        className="joc-dash-link"
        aria-label={link.label}
        onClick={link.onClick}
      >
        {children}
      </button>
    );
  }
  return (
    <a
      className="joc-dash-link"
      href={link.href}
      aria-label={link.label}
      {...(link.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
    >
      {children}
    </a>
  );
}

export function DashBody({ children }: { children: ReactNode }) {
  return <div className="joc-dash-pb">{children}</div>;
}

/** The dashboard's column: header, KPI strip, then the panels or the filtered table. */
export function Dashboard({ children }: { children: ReactNode }) {
  return <div className="joc-dash">{children}</div>;
}

/** The header's line on how fresh the numbers are. */
export function DashSync({ children }: { children: ReactNode }) {
  return <span className="joc-dash-sync">{children}</span>;
}

/** The filtered table under the drill bar. */
export function DashDrill({ children }: { children: ReactNode }) {
  return (
    <section className="joc-dash-drill" aria-label="Filtered work">
      {children}
    </section>
  );
}

export function DashGrid({ children }: { children: ReactNode }) {
  return <div className="joc-dash-grid">{children}</div>;
}

export interface DashStageProps {
  id: DashStageId;
  label: string;
  count: number;
  /** How many of them need you, and how many have a failing check or deploy. */
  needs: number;
  failing: number;
  selected?: boolean;
  /** Waits on GitHub. */
  off?: boolean;
  onSelect?: () => void;
}

/** A stage's swatch on the neutral ramp. */
export function DashSwatch({ stage }: { stage: DashStageId | 'merges' | 'deploys' }) {
  const kind = stage === 'merges' || stage === 'deploys' ? `sw--${stage}` : `st--${stage}`;
  return <span className={cx('joc-dash-sw', `joc-dash-${kind}`)} aria-hidden="true" />;
}

function DashStage({ id, label, count, needs, failing, selected, off, onSelect }: DashStageProps) {
  const head = (
    <span className="joc-dash-stage__head">
      <DashSwatch stage={id} />
      <span>{label}</span>
    </span>
  );
  if (off) {
    return (
      <div
        className="joc-dash-stage is-off"
        title={`${label}: available after GitHub is connected`}
      >
        {head}
        <span className="joc-dash-stage__num">—</span>
        <span className="joc-dash-stage__stuck">Needs GitHub</span>
      </div>
    );
  }
  const stuck = Math.max(needs, failing);
  return (
    <button
      type="button"
      className={cx('joc-dash-stage', selected && 'is-selected')}
      aria-pressed={!!selected}
      aria-label={`${label}: ${count}, ${stuck} stuck. Open the table filtered to this stage`}
      onClick={onSelect}
    >
      {head}
      <span className="joc-dash-stage__num">{count}</span>
      <span className="joc-dash-stage__stuck">
        {needs ? (
          <span className="joc-dash-needs-text">
            {needs} {needs === 1 ? 'needs you' : 'need you'}
          </span>
        ) : null}
        {failing ? (
          <span className="joc-dash-fail">
            <CIMark status="fail" size={12} />
            <span>{failing} failing</span>
          </span>
        ) : null}
        {!needs && !failing ? <span>Nothing stuck</span> : null}
      </span>
    </button>
  );
}

export function DashPipeline({ stages, note }: { stages: DashStageProps[]; note: string }) {
  return (
    <div className="joc-dash-pb">
      <div className="joc-dash-flow">
        {stages.map((s, i) => (
          <Fragment key={s.id}>
            {i > 0 ? (
              <span className="joc-dash-arrow" aria-hidden="true">
                <Icon name="chevronRight" size={14} className="is-right" />
                <Icon name="chevronDown" size={14} className="is-down" />
              </span>
            ) : null}
            <DashStage {...s} />
          </Fragment>
        ))}
      </div>
      <p className="joc-dash-note">{note}</p>
    </div>
  );
}

export interface DashNeedProps {
  /** Why: "Deploy failed", "Answer Claude", ... */
  reason: string;
  title: string;
  repo: string;
  /** `#482`, or the branch. */
  refText: string;
  wait: string;
  /** The one-click action, named: "Open deploy run". */
  action: string;
  link: OpLink;
  /** Resolved: it fades out in place. */
  leaving?: boolean;
}

export function DashNeed({
  reason,
  title,
  repo,
  refText,
  wait,
  action,
  link,
  leaving,
}: DashNeedProps) {
  const inside = (
    <>
      <span className="joc-dash-need__main">
        <span className="joc-dash-need__l1">
          <StateBadge state="needs" label={reason} />
          <span className="joc-dash-need__title">{title}</span>
        </span>
        <span className="joc-dash-need__l2">
          <span>{repo}</span>
          <span aria-hidden="true">·</span>
          <span className="joc-dash-need__ref">{refText}</span>
          <span aria-hidden="true">·</span>
          <span>{wait}</span>
        </span>
      </span>
      <span className="joc-dash-need__go">
        <span>{action}</span>
        <Icon name="chevronRight" size={12} />
      </span>
    </>
  );
  const cls = cx('joc-dash-need', leaving && 'is-leaving');
  const label = `${action}: ${title}, ${repo}, ${wait}`;
  if (link.onClick && !link.href) {
    return (
      <button type="button" className={cls} aria-label={label} onClick={link.onClick}>
        {inside}
      </button>
    );
  }
  return (
    <a
      className={cls}
      href={link.href}
      aria-label={label}
      aria-hidden={leaving || undefined}
      tabIndex={leaving ? -1 : undefined}
      {...(link.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
    >
      {inside}
    </a>
  );
}

export function DashNeeds({ children }: { children: ReactNode }) {
  return <div className="joc-dash-needs">{children}</div>;
}

export interface DashEmptyProps {
  icon: IconName;
  title: string;
  body: string;
  action?: ReactNode;
}

/** A panel with nothing in it yet: what arrives here. */
export function DashEmpty({ icon, title, body, action }: DashEmptyProps) {
  return (
    <div className="joc-dash-empty">
      <span className="joc-dash-icon">
        <Icon name={icon} size={16} />
      </span>
      <span className="joc-dash-empty__title">{title}</span>
      <p className="joc-dash-empty__body">{body}</p>
      {action}
    </div>
  );
}

/** An event's glyph: a session's state, an outcome, or an icon. */
export type DashGlyph = { dot: SessionState } | { ci: CIStatus } | { icon: IconName };

export interface DashEventProps {
  time: string;
  glyph: DashGlyph;
  /** What happened, what to, and where: "CI failed on", "#218 unit-tests", "billing-api". */
  what: string;
  subject: string;
  where: string;
  /** Just arrived: it fades in. */
  fresh?: boolean;
}

export function DashEvent({ time, glyph, what, subject, where, fresh }: DashEventProps) {
  return (
    <div className={cx('joc-dash-ev', fresh && 'joc-fade-in')}>
      <span className="joc-dash-ev__t">{time}</span>
      <span className="joc-dash-ev__g">
        {'dot' in glyph ? (
          <StateDot state={glyph.dot} />
        ) : 'ci' in glyph ? (
          <CIMark status={glyph.ci} size={14} />
        ) : (
          <Icon name={glyph.icon} size={14} />
        )}
      </span>
      <span className="joc-dash-ev__x">
        <span className="joc-dash-ev__a">{what}</span>
        <span className="joc-dash-ev__b">{subject}</span>
        <span className="joc-dash-ev__c">{where}</span>
      </span>
    </div>
  );
}

/** The live feed: clipped to eight rows, newest at the top; it never scrolls itself. */
export function DashFeed({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="joc-dash-feed" role="log" aria-live="polite" aria-label={label}>
      {children}
    </div>
  );
}

export interface DashRepoProps {
  repo: string;
  inflight: number;
  needs: number;
  /** Its work by stage, in stage order; empty stages left out. */
  segments: { stage: DashStageId; label: string; short: string; count: number }[];
  note?: string;
  selected?: boolean;
  onSelect: () => void;
}

export function DashRepo({
  repo,
  inflight,
  needs,
  segments,
  note,
  selected,
  onSelect,
}: DashRepoProps) {
  const [owner, name] = repo.includes('/')
    ? [repo.slice(0, repo.indexOf('/') + 1), repo.slice(repo.indexOf('/') + 1)]
    : ['', repo];
  return (
    <button
      type="button"
      className={cx('joc-dash-repo', selected && 'is-selected')}
      aria-pressed={!!selected}
      aria-label={`${repo}: ${inflight} in flight${needs ? `, ${needs} need you` : ''}. Open the table filtered to this repo`}
      onClick={onSelect}
    >
      <span className="joc-dash-repo__name">
        <span className="joc-dash-icon">
          <Icon name="folder" size={14} />
        </span>
        <span>
          <span className="joc-dash-repo__owner">{owner}</span>
          <span>{name}</span>
        </span>
      </span>
      <span className="joc-dash-repo__nums">
        <span className="joc-dash-repo__big">{inflight}</span>
        <span>in flight</span>
        {needs ? (
          <span className="joc-dash-needs-text">
            {needs} {needs === 1 ? 'needs you' : 'need you'}
          </span>
        ) : null}
      </span>
      <span
        className="joc-dash-bar"
        role="img"
        aria-label={
          segments.length
            ? segments.map((s) => `${s.label} ${s.count}`).join(', ')
            : 'Nothing today'
        }
      >
        {segments.map((s) => (
          <span
            key={s.stage}
            className={`joc-dash-st--${s.stage}`}
            style={{ flex: `${s.count} 1 0px` }}
            title={`${s.label}: ${s.count}`}
          />
        ))}
      </span>
      <span className="joc-dash-key">
        {segments.map((s) => (
          <span key={s.stage}>
            <DashSwatch stage={s.stage} />
            {s.short} {s.count}
          </span>
        ))}
        {segments.length ? null : <span>Nothing in flight or shipped today</span>}
      </span>
      {note ? <span className="joc-dash-repo__note">{note}</span> : null}
    </button>
  );
}

export function DashRepos({ children }: { children: ReactNode }) {
  return (
    <div className="joc-dash-pb">
      <div className="joc-dash-repos">{children}</div>
    </div>
  );
}

export interface DashMachineProps {
  name: string;
  /** "Online", or "Last seen 3h ago". */
  status: string;
  online: boolean;
  live: number;
  /** Its sessions by state, states with none left out. */
  states: { state: SessionState; count: number }[];
  selected?: boolean;
  onSelect: () => void;
}

export function DashMachine({
  name,
  status,
  online,
  live,
  states,
  selected,
  onSelect,
}: DashMachineProps) {
  return (
    <button
      type="button"
      className={cx('joc-dash-machine', selected && 'is-selected')}
      aria-pressed={!!selected}
      aria-label={`${name}, ${online ? 'online' : 'offline'}, ${live} live ${live === 1 ? 'session' : 'sessions'}. Open the table filtered to this machine`}
      onClick={onSelect}
    >
      <span className="joc-dash-machine__l1">
        <span className="joc-dash-icon">
          <Icon name="terminal" size={14} />
        </span>
        <span className="joc-dash-machine__name">{name}</span>
        <span className={cx('joc-dash-machine__on', !online && 'is-off')}>{status}</span>
      </span>
      <span className="joc-dash-machine__l2">
        <span className="joc-dash-machine__n">{live}</span>
        <span>{live === 1 ? 'live session' : 'live sessions'}</span>
        {states.map((s) => (
          <span key={s.state} className="joc-dash-sc" title={`${STATE_LABEL[s.state]}: ${s.count}`}>
            <StateDot state={s.state} label={`${STATE_LABEL[s.state]}: ${s.count}`} />
            <span>{s.count}</span>
          </span>
        ))}
      </span>
    </button>
  );
}

export function DashMachines({ children }: { children: ReactNode }) {
  return <div className="joc-dash-machines">{children}</div>;
}

export interface DashThroughputProps {
  merges: number;
  deploys: number;
  /** The median from a session's start to its merge, in words; "—" without one. */
  median: string;
  /** Oldest first, today last. */
  days: { label: string; merges: number; deploys: number; today?: boolean }[];
}

/** The tallest bar's height; the totals above carry the scale. */
const CHART_PX = 80;

export function DashThroughput({ merges, deploys, median, days }: DashThroughputProps) {
  const max = Math.max(1, ...days.map((d) => Math.max(d.merges, d.deploys)));
  const px = (n: number) => Math.round((n / max) * CHART_PX);
  const today = days.at(-1);
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
  return (
    <div className="joc-dash-pb">
      <div className="joc-dash-stats">
        <div className="joc-dash-stat">
          <span className="joc-dash-stat__n">{merges}</span>
          <span className="joc-dash-stat__l">Merges</span>
        </div>
        <div className="joc-dash-stat">
          <span className="joc-dash-stat__n">{deploys}</span>
          <span className="joc-dash-stat__l">Deploys</span>
        </div>
        <div className="joc-dash-stat">
          <span className="joc-dash-stat__n">{median}</span>
          <span className="joc-dash-stat__l">Median, session start to merge</span>
        </div>
      </div>
      <div
        className="joc-dash-chart"
        role="img"
        aria-label={`Merges and deploys per day, last 7 days: ${days
          .map((d) => `${d.label} ${plural(d.merges, 'merge')}, ${plural(d.deploys, 'deploy')}`)
          .join('; ')}`}
      >
        {days.map((d) => (
          <div key={d.label} className="joc-dash-day">
            <span
              className="joc-dash-b is-merges"
              style={{ height: px(d.merges) }}
              title={`${d.label}: ${plural(d.merges, 'merge')}`}
            />
            <span
              className="joc-dash-b is-deploys"
              style={{ height: px(d.deploys) }}
              title={`${d.label}: ${plural(d.deploys, 'deploy')}`}
            />
          </div>
        ))}
      </div>
      <div className="joc-dash-days" aria-hidden="true">
        {days.map((d) => (
          <span key={d.label} className={d.today ? 'is-today' : undefined}>
            {d.label}
          </span>
        ))}
      </div>
      <div className="joc-dash-key">
        <span>
          <DashSwatch stage="merges" />
          Merges
        </span>
        <span>
          <DashSwatch stage="deploys" />
          Deploys
        </span>
        {today ? (
          <span>
            Today: {plural(today.merges, 'merge')}, {plural(today.deploys, 'deploy')}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export interface DashDrillBarProps {
  /** What the table is filtered to: "Needs you", "Stage: Review", a repo. */
  label: string;
  count: number;
  onBack: () => void;
}

/** Over the filtered table: the way back, and the filter as a chip that clears. */
export function DashDrillBar({ label, count, onBack }: DashDrillBarProps) {
  return (
    <div className="joc-dash-drillbar">
      <button type="button" className="joc-dash-btn" onClick={onBack}>
        Back to overview
      </button>
      <span className="joc-dash-drillbar__said">Showing</span>
      <span className="joc-dash-chip">
        <span>{label}</span>
        <span className="joc-dash-chip__n">{count}</span>
        <button
          type="button"
          className="joc-dash-chip__x"
          aria-label="Clear filter"
          onClick={onBack}
        >
          <Icon name="x" size={12} />
        </button>
      </span>
    </div>
  );
}

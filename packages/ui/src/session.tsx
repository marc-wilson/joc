import type { SessionState } from '@joc/protocol';
import { Fragment, type ReactNode } from 'react';
import { ContextMeter } from './ContextMeter.tsx';
import { type TabItem, Tabs } from './controls.tsx';
import { cx } from './cx.ts';
import { Icon } from './Icon.tsx';
import { Branch } from './inline.tsx';
import { STATE_LABEL, StateBadge, StateDot } from './state.tsx';

export interface SessionRowProps {
  /** Stable key when titles can repeat. */
  id?: string;
  state?: SessionState;
  title: string;
  /** Accepted but not shown: the repo group header carries the repo. */
  repo?: string;
  branch?: string;
  contextLeft?: number;
  activity?: ReactNode;
  time?: string;
  selected?: boolean;
  needsLabel?: string;
  /** Kept in the Pinned group at the top of the list. */
  pinned?: boolean;
  /**
   * Its machine stopped reporting, e.g. "Quiet 6m": shown in place of the time, and the state dot
   * keeps its shape but stops its live motion.
   */
  quiet?: string;
  onSelect?: () => void;
  /** Shows a pin button in the time's place on hover or focus. */
  onPinChange?: (pinned: boolean) => void;
}

export function SessionRow({
  state = 'idle',
  title,
  branch,
  contextLeft,
  activity,
  time,
  selected,
  needsLabel,
  pinned,
  quiet,
  onSelect,
  onPinChange,
}: SessionRowProps) {
  return (
    <div
      className={cx(
        'joc-srow',
        `joc-srow--${state}`,
        selected && 'is-selected',
        quiet && 'is-quiet',
      )}
      role="option"
      aria-selected={!!selected}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect?.();
        }
      }}
    >
      <span className="joc-srow__rail" aria-hidden="true" />
      <span className="joc-srow__glyph">
        <StateDot
          state={state}
          quiet={!!quiet}
          label={quiet ? `${STATE_LABEL[state]}, ${quiet.toLowerCase()}` : undefined}
        />
      </span>
      <span className="joc-srow__main">
        <span className="joc-srow__line1">
          <span className="joc-srow__title">{title}</span>
          {state === 'needs' ? (
            <StateBadge state="needs" label={needsLabel || 'Needs you'} />
          ) : null}
          {quiet ? (
            <span className="joc-srow__time joc-quiet">
              <Icon name="clock" size={12} />
              {quiet}
            </span>
          ) : (
            <span className="joc-srow__time">{time}</span>
          )}
        </span>
        <span className="joc-srow__line2">
          <span className="joc-srow__where" title={branch}>
            {branch ? <Branch>{branch}</Branch> : null}
          </span>
          <span className="joc-srow__meter">
            {/* No meter until the context is known: an empty one would read as 100%. */}
            {contextLeft != null ? <ContextMeter left={contextLeft} /> : null}
          </span>
        </span>
        {/* Keyed on the text so each new activity line fades in. */}
        <span
          className="joc-srow__activity joc-fade-in"
          key={typeof activity === 'string' ? activity : undefined}
        >
          {activity}
        </span>
      </span>
      {onPinChange ? (
        <button
          type="button"
          className="joc-pin"
          aria-pressed={!!pinned}
          aria-label={pinned ? `Unpin ${title}` : `Pin ${title}`}
          title={pinned ? 'Unpin' : 'Pin to the top'}
          onClick={(e) => {
            e.stopPropagation();
            onPinChange(!pinned);
          }}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <Icon name="pin" size={14} filled={pinned} />
        </button>
      ) : null}
    </div>
  );
}

/** The pin glyph that marks the Pinned group, in its header and in the folded rail. */
function PinGlyph() {
  return <Icon name="pin" size={12} filled className="joc-pin-glyph" />;
}

export interface RepoGroupHeaderProps {
  repo: string;
  count: number;
  needs?: number;
  collapsed?: boolean;
  /** Heads the Pinned group: a pin glyph, and it doesn't fold. */
  pinned?: boolean;
  onToggle?: () => void;
}

export function RepoGroupHeader({
  repo,
  count,
  needs,
  collapsed,
  pinned,
  onToggle,
}: RepoGroupHeaderProps) {
  if (pinned) {
    return (
      <h3 className="joc-rgh joc-rgh--pinned">
        <PinGlyph />
        <span className="joc-rgh__name">{repo}</span>
        <span className="joc-rgh__count">{count}</span>
        {needs ? <StateBadge state="needs" label={String(needs)} /> : null}
      </h3>
    );
  }
  return (
    <button className="joc-rgh" aria-expanded={!collapsed} type="button" onClick={onToggle}>
      <Icon name={collapsed ? 'chevronRight' : 'chevronDown'} size={12} />
      <span className="joc-rgh__name">{repo}</span>
      <span className="joc-rgh__count">{count}</span>
      {needs ? <StateBadge state="needs" label={String(needs)} /> : null}
    </button>
  );
}

export interface NewSessionButtonProps {
  repo?: string;
  label?: string;
  onClick?: () => void;
}

export function NewSessionButton({ repo, label = 'New session', onClick }: NewSessionButtonProps) {
  return (
    <button
      type="button"
      className="joc-newsession"
      aria-label={repo ? `New session in ${repo}` : 'New session'}
      onClick={onClick}
    >
      <Icon name="plus" size={14} />
      <span>{label}</span>
    </button>
  );
}

export interface SessionHeaderProps {
  title: string;
  state?: SessionState;
  stateLabel?: string;
  repo?: string;
  branch?: string;
  machine?: string;
  model?: string;
  contextLeft?: number;
  tabs?: TabItem[];
  tab?: string;
  onTabChange?: (id: string) => void;
  children?: ReactNode;
}

export function SessionHeader({
  title,
  state = 'idle',
  stateLabel,
  repo,
  branch,
  machine,
  model,
  contextLeft,
  tabs,
  tab,
  onTabChange,
  children,
}: SessionHeaderProps) {
  return (
    <div className="joc-shead">
      <div className="joc-shead__top">
        <div className="joc-shead__id">
          <h1 className="joc-shead__title">{title}</h1>
          <StateBadge state={state} label={stateLabel} />
        </div>
        <div className="joc-shead__actions">{children}</div>
      </div>
      <div className="joc-shead__meta">
        {repo ? <span>{repo}</span> : null}
        {branch ? <Branch>{branch}</Branch> : null}
        {machine ? (
          <span className="joc-shead__machine">
            <Icon name="terminal" size={12} />
            {machine}
          </span>
        ) : null}
        {model ? <span>{model}</span> : null}
        {contextLeft != null ? (
          <span className="joc-shead__ctx">
            Context
            <ContextMeter left={contextLeft} />
          </span>
        ) : null}
      </div>
      {tabs ? <Tabs items={tabs} value={tab} onChange={onTabChange} /> : null}
    </div>
  );
}

export interface SessionLinkProps {
  title: string;
  state?: SessionState;
  href?: string;
}

export function SessionLink({ title, state = 'idle', href = '#' }: SessionLinkProps) {
  return (
    <a href={href} className="joc-slink" title={`Open session: ${title}`}>
      <StateDot state={state} />
      <span className="joc-slink__title">{title}</span>
      {state === 'needs' ? <StateBadge state="needs" /> : null}
    </a>
  );
}

// Two-letter repo mark for the collapsed rail: "atlas-web" → "aw".
function shortRepo(repo: string): string {
  const name = repo.split('/').pop() ?? '';
  const parts = name.split(/[-_.]+/).filter(Boolean);
  return (
    parts.length > 1 ? `${parts[0]?.charAt(0)}${parts[1]?.charAt(0)}` : name.slice(0, 2)
  ).toLowerCase();
}

export interface SessionRailGroup {
  repo: string;
  /** The Pinned group: marked with the pin glyph, first, above the repos. */
  pinned?: boolean;
  sessions: SessionRowProps[];
}

export interface SessionRailProps {
  groups: SessionRailGroup[];
  peek?: boolean;
  onExpand?: () => void;
  onSelect?: (session: SessionRowProps) => void;
}

/** The session list collapsed to state dots, for screens that need the width. */
export function SessionRail({ groups, peek, onExpand, onSelect }: SessionRailProps) {
  const needs = groups.flatMap((g) => g.sessions).filter((s) => s.state === 'needs').length;
  const describe = (s: SessionRowProps) => `${s.title} — ${STATE_LABEL[s.state ?? 'idle']}`;
  return (
    <nav className={cx('joc-rail', peek && 'is-peek')} aria-label="Sessions (collapsed)">
      <button
        type="button"
        className="joc-rail__toggle"
        aria-label="Expand session list"
        aria-expanded="false"
        onClick={onExpand}
        title="Expand session list  ["
      >
        <Icon name="sidebar" size={16} />
      </button>
      {needs ? (
        <span className="joc-rail__needs" title={`${needs} sessions need you`}>
          <span className="joc-sdot joc-sdot--needs" aria-hidden="true" />
          {needs}
        </span>
      ) : null}
      <div className="joc-rail__list">
        {groups.map((g) => (
          // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring form semantics to a nav list
          <div key={g.repo} className="joc-rail__group" role="group" aria-label={g.repo}>
            {g.pinned ? (
              <span className="joc-rail__pin" title={g.repo} aria-hidden="true">
                <PinGlyph />
              </span>
            ) : (
              <span className="joc-rail__repo" title={g.repo} aria-hidden="true">
                {shortRepo(g.repo)}
              </span>
            )}
            {g.sessions.map((s) => (
              <button
                key={s.id ?? s.title}
                type="button"
                className={cx(
                  'joc-rail__item',
                  `joc-rail__item--${s.state ?? 'idle'}`,
                  s.selected && 'is-selected',
                )}
                aria-label={describe(s)}
                aria-current={s.selected ? 'true' : undefined}
                title={s.title}
                onClick={() => onSelect?.(s)}
              >
                <StateDot state={s.state} quiet={!!s.quiet} label={describe(s)} />
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="joc-rail__peek" aria-hidden={peek ? undefined : 'true'}>
        {groups.map((g) => (
          <Fragment key={g.repo}>
            <RepoGroupHeader repo={g.repo} count={g.sessions.length} pinned={g.pinned} />
            {g.sessions.map((s) => (
              <SessionRow key={s.id ?? s.title} {...s} />
            ))}
          </Fragment>
        ))}
      </div>
    </nav>
  );
}

export interface SessionListNoteProps {
  children: ReactNode;
}

/** A quiet line inside the session list: a section label, or that nothing matches. */
export function SessionListNote({ children }: SessionListNoteProps) {
  return (
    <div className="joc-slnote">
      <span className="joc-slnote__text">{children}</span>
    </div>
  );
}

export interface SessionListFooterProps {
  /** What the list leaves out and why. */
  children: ReactNode;
  /** `TextLink`s after the text, e.g. History and Change. */
  links?: ReactNode;
}

/** The note under the session list, below its scroll: how long sessions stay, and where to look. */
export function SessionListFooter({ children, links }: SessionListFooterProps) {
  return (
    <div className="joc-slist__foot">
      <span className="joc-slist__foot-text">{children}</span>
      {links ? <span className="joc-slist__foot-links">{links}</span> : null}
    </div>
  );
}

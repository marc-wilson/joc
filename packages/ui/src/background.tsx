import type { SessionState } from '@joc/protocol';
import type { ReactNode } from 'react';
import { ContextMeter } from './ContextMeter.tsx';
import { CIMark } from './ci.tsx';
import { cx } from './cx.ts';
import { Icon, type IconName } from './Icon.tsx';
import { StateBadge, StateDot } from './state.tsx';

const KIND_ICON: Record<string, IconName> = {
  shell: 'terminal',
  subagent: 'sparkle',
  watch: 'file',
};

export interface TaskRowProps {
  kind?: 'shell' | 'subagent';
  kindLabel?: string;
  title: string;
  command?: string;
  /** What a running task is doing now, one line; it fades in as it changes. */
  step?: string;
  /** One line on how it ended, or where it stands. */
  tail?: string;
  elapsed?: string;
  state?: SessionState;
  result?: 'pass' | 'fail';
  /** Makes the row a toggle that shows `details` under it. A toggle row takes no `children`. */
  onToggle?: () => void;
  open?: boolean;
  /** Shown under the row while it's open, e.g. a `TaskDetails`. */
  details?: ReactNode;
  /** Extra classes on the row, e.g. `joc-fade-in` for a row that just moved here. */
  className?: string;
  children?: ReactNode;
}

/**
 * A background shell command or subagent: state dot while running, check or cross when done.
 * With `onToggle` the whole row opens its details in place, under it.
 */
export function TaskRow({
  kind = 'shell',
  kindLabel,
  title,
  command,
  step,
  tail,
  elapsed,
  state = 'background',
  result,
  onToggle,
  open = false,
  details,
  className: extra,
  children,
}: TaskRowProps) {
  const className = cx(
    'joc-task',
    `joc-task--${result ? 'done' : state}`,
    onToggle && 'is-button',
    !result && state === 'background' && 'is-live',
    onToggle && open && 'is-open',
    extra,
  );
  const content = (
    <>
      <span className="joc-task__lead">
        {result ? <CIMark status={result} size={12} /> : <StateDot state={state} />}
      </span>
      <span className="joc-task__main">
        <span className="joc-task__line1">
          <span className="joc-task__kind">
            <Icon name={KIND_ICON[kind] ?? 'terminal'} size={12} />
            {kindLabel || (kind === 'subagent' ? 'Subagent' : 'Shell')}
          </span>
          <span className="joc-task__title">{title}</span>
          <span className="joc-task__elapsed">{elapsed}</span>
        </span>
        {command ? <code className="joc-task__cmd">{command}</code> : null}
        {step ? (
          <span className="joc-task__step" key={step}>
            {step}
          </span>
        ) : tail ? (
          <span className="joc-task__tail joc-fade-in" key={tail}>
            {tail}
          </span>
        ) : null}
      </span>
      <span className="joc-task__actions">
        {onToggle ? (
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} className="joc-task__chev" />
        ) : (
          children
        )}
      </span>
    </>
  );
  if (!onToggle) return <div className={className}>{content}</div>;
  return (
    <>
      <button type="button" className={className} aria-expanded={open} onClick={onToggle}>
        {content}
      </button>
      {open ? details : null}
    </>
  );
}

export interface TaskShowAllProps {
  /** All the finished tasks there are. */
  count: number;
  /** All of them are shown now. */
  all: boolean;
  /** How many show otherwise. */
  latest: number;
  onClick: () => void;
}

/** The full-width button under the finished tasks: "Show all 23", or back to the latest few. */
export function TaskShowAll({ count, all, latest, onClick }: TaskShowAllProps) {
  return (
    <button type="button" className="joc-showall" onClick={onClick}>
      {all ? 'Show latest' : 'Show all'}
      <span className="joc-showall__n">{all ? latest : count}</span>
    </button>
  );
}

/** What a background task was asked, what it did and how it ended, under its `TaskRow`. */
export function TaskDetails({ children }: { children?: ReactNode }) {
  return <div className="joc-taskd">{children}</div>;
}

export interface TaskSectionProps {
  title: string;
  /** A count or a few words beside the title, e.g. the number of steps or "exit 1". */
  meta?: ReactNode;
  /** A line under the content, e.g. `TextLink`s to copy it. */
  foot?: ReactNode;
  children?: ReactNode;
}

/** One part of a task's details: "Asked", "Steps", "Report", "Command", "Output". */
export function TaskSection({ title, meta, foot, children }: TaskSectionProps) {
  return (
    <section className="joc-taskd__sec">
      <h4 className="joc-taskd__label">
        {title}
        {meta != null ? <span className="joc-taskd__count">{meta}</span> : null}
      </h4>
      {children}
      {foot ? <div className="joc-taskd__foot">{foot}</div> : null}
    </section>
  );
}

/** What a subagent was asked, as written. */
export function TaskAsked({ children }: { children?: ReactNode }) {
  return <p className="joc-taskd__asked">{children}</p>;
}

/** A line in a section that has nothing to show yet, e.g. a report still to come. */
export function TaskPending({ children }: { children?: ReactNode }) {
  return <p className="joc-taskd__pending">{children}</p>;
}

/** A subagent's report: capped in height, it scrolls inside. */
export function TaskReport({
  label = 'Report',
  children,
}: {
  label?: string;
  children?: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must take focus to scroll by keyboard
    <section className="joc-taskd__report" tabIndex={0} aria-label={label}>
      {children}
    </section>
  );
}

/** What a shell printed: capped in height, it scrolls inside; long lines wrap. */
export function TaskOutput({ children }: { children?: string }) {
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must take focus to scroll by keyboard
    <pre className="joc-taskd__output" tabIndex={0}>
      {children}
    </pre>
  );
}

export interface TaskStep {
  id: string;
  /** The tool, e.g. "Read". */
  tool: string;
  /** What it worked on, e.g. a path. */
  target?: string;
  /** When it started, from the task's start, e.g. "1:12". */
  time?: string;
  /** `current` is the step a running task is on now. */
  status: 'done' | 'fail' | 'current';
}

/** A subagent's steps, one dense line each: a mark, the tool, what it worked on, when. */
export function TaskSteps({ steps }: { steps: TaskStep[] }) {
  return (
    <ol className="joc-steps">
      {steps.map((s) => (
        <li key={s.id} className={cx('joc-step', s.status === 'current' && 'is-current')}>
          {s.status === 'current' ? (
            <StateDot state="background" label="Running" />
          ) : (
            <CIMark status={s.status === 'fail' ? 'fail' : 'pass'} size={12} />
          )}
          <span className="joc-step__tool">{s.tool}</span>
          <span className="joc-step__target">{s.target}</span>
          <span className="joc-step__time">{s.time}</span>
        </li>
      ))}
    </ol>
  );
}

export interface AgentTeamMember {
  name: string;
  role?: string;
  state: SessionState;
  activity?: string;
  contextLeft?: number;
  lead?: boolean;
}

export interface AgentTeamProps {
  title: string;
  goal?: string;
  members: AgentTeamMember[];
  children?: ReactNode;
}

export function AgentTeam({ title, goal, members, children }: AgentTeamProps) {
  return (
    <section className="joc-team">
      <div className="joc-team__head">
        <span className="joc-team__title">{title}</span>
        <span className="joc-team__sub">
          {members.length} agents{goal ? ` · ${goal}` : ''}
        </span>
        <span className="joc-team__actions">{children}</span>
      </div>
      <div className="joc-team__members">
        {members.map((m) => (
          <div
            key={m.name}
            className={cx('joc-team__member', `joc-team__member--${m.state}`, m.lead && 'is-lead')}
          >
            <StateDot state={m.state} />
            <span className="joc-team__name">
              {m.name}
              {m.lead ? <span className="joc-tag">Lead</span> : null}
            </span>
            <span className="joc-team__role">{m.role}</span>
            <span className="joc-team__activity">{m.activity}</span>
            {m.state === 'needs' ? (
              <StateBadge state="needs" />
            ) : (
              <ContextMeter left={m.contextLeft ?? 100} />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

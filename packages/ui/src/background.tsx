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
  tail?: string;
  elapsed?: string;
  state?: SessionState;
  result?: 'pass' | 'fail';
  /** Makes the row a toggle that shows `details` under it. A toggle row takes no `children`. */
  onToggle?: () => void;
  open?: boolean;
  /** Shown under the row while it's open, e.g. a `TaskDetails`. */
  details?: ReactNode;
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
  tail,
  elapsed,
  state = 'background',
  result,
  onToggle,
  open = false,
  details,
  children,
}: TaskRowProps) {
  const className = cx('joc-task', `joc-task--${result ? 'done' : state}`, onToggle && 'is-toggle');
  const content = (
    <>
      <span className="joc-task__lead">
        {result ? <CIMark status={result} /> : <StateDot state={state} />}
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
        {tail ? (
          <span className="joc-task__tail joc-fade-in" key={tail}>
            {tail}
          </span>
        ) : null}
      </span>
      <span className="joc-task__actions">
        {onToggle ? <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} /> : children}
      </span>
    </>
  );
  if (!onToggle) return <div className={className}>{content}</div>;
  return (
    <>
      <button type="button" className={className} aria-expanded={open} onClick={onToggle}>
        {content}
      </button>
      {open && details ? <div className="joc-task__details">{details}</div> : null}
    </>
  );
}

export interface TaskFact {
  label: string;
  value: ReactNode;
}

export interface TaskDetailsProps {
  /** Short facts in one row: type, status, started, duration. */
  facts?: TaskFact[];
  /** `TaskSection`s: what it was asked, what it did, how it ended. */
  children?: ReactNode;
}

/** What a background task was asked, what it did and how it ended, under its `TaskRow`. */
export function TaskDetails({ facts, children }: TaskDetailsProps) {
  return (
    <div className="joc-taskd joc-fade-in">
      {facts?.length ? (
        <dl className="joc-taskd__facts">
          {facts.map((f) => (
            <div key={f.label} className="joc-taskd__fact">
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {children}
    </div>
  );
}

export interface TaskSectionProps {
  title: string;
  /** Code or terminal output: mono, on a sunken surface, lines wrapped. */
  mono?: boolean;
  /** Plain text, kept as written: line breaks wrap instead of running together. */
  pre?: boolean;
  children?: ReactNode;
}

export function TaskSection({ title, mono, pre, children }: TaskSectionProps) {
  return (
    <section className="joc-taskd__section">
      <h4 className="joc-taskd__title">{title}</h4>
      <div className={cx('joc-taskd__body', mono && 'is-mono', pre && 'is-pre')}>{children}</div>
    </section>
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

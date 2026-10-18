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
  children?: ReactNode;
}

/** A background shell command or subagent: state dot while running, check or cross when done. */
export function TaskRow({
  kind = 'shell',
  kindLabel,
  title,
  command,
  tail,
  elapsed,
  state = 'background',
  result,
  children,
}: TaskRowProps) {
  return (
    <div className={cx('joc-task', `joc-task--${result ? 'done' : state}`)}>
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
      <span className="joc-task__actions">{children}</span>
    </div>
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

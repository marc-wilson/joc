import type { SessionState } from '@joc/protocol';
import type { ReactNode } from 'react';
import { CopyCommand } from './code.tsx';
import { Button } from './controls.tsx';
import { Icon, type IconName } from './Icon.tsx';
import { StateDot } from './state.tsx';

export interface BannerProps {
  /** One sentence; commands in it are `Code`. */
  title: ReactNode;
  /** More on one line after the title, e.g. `BannerSessions` or a short instruction. */
  children?: ReactNode;
  icon?: IconName;
  /** A command to copy. It takes its own line when the banner is narrow, and scrolls. */
  command?: string;
  /** Buttons or links at the end of the strip, e.g. "Reload". */
  actions?: ReactNode;
  onDismiss?: () => void;
}

/**
 * A calm, app-wide notice under the nav bar: something about JOC itself the person should act on
 * (a plugin to update, a newer dashboard). Neutral on purpose: orange stays for `needs`. It wraps
 * rather than clip.
 */
export function Banner({
  title,
  children,
  icon = 'sparkle',
  command,
  actions,
  onDismiss,
}: BannerProps) {
  return (
    <output className="joc-banner joc-fade-in">
      <Icon name={icon} className="joc-banner__icon" />
      <div className="joc-banner__text">
        <span>{title}</span>
        {children}
      </div>
      {command ? <CopyCommand command={command} /> : null}
      {actions || onDismiss ? (
        <div className="joc-banner__actions">
          {actions}
          {onDismiss ? (
            <Button variant="ghost" size="sm" icon="x" aria-label="Dismiss" onClick={onDismiss} />
          ) : null}
        </div>
      ) : null}
    </output>
  );
}

export interface BannerSession {
  id: string;
  title: string;
  state?: SessionState;
  href: string;
}

export interface BannerSessionsProps {
  sessions: BannerSession[];
  /** Shown by name before "+N more". */
  max?: number;
}

/** The sessions a banner is about, as small links with their state; past `max`, "+N more". */
export function BannerSessions({ sessions, max = 3 }: BannerSessionsProps) {
  const shown = sessions.length > max ? sessions.slice(0, max - 1) : sessions;
  const more = sessions.length - shown.length;
  return (
    <span className="joc-banner__sessions">
      {shown.map((s) => (
        <a key={s.id} className="joc-banner__session" href={s.href} title={s.title}>
          <StateDot state={s.state} />
          <span>{s.title}</span>
        </a>
      ))}
      {more > 0 ? <span className="joc-banner__more">+{more} more</span> : null}
    </span>
  );
}

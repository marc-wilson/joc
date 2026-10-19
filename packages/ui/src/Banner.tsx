import type { ReactNode } from 'react';
import { Button } from './controls.tsx';
import { Icon, type IconName } from './Icon.tsx';

export interface BannerProps {
  title: string;
  /** What to do about it: a sentence, a command to copy. */
  children?: ReactNode;
  icon?: IconName;
  /** Buttons at the end of the strip, e.g. "Reload". */
  actions?: ReactNode;
  onDismiss?: () => void;
}

/**
 * A calm, app-wide notice under the nav bar: something about JOC itself the person should act on
 * (a plugin to update, a newer dashboard). Neutral on purpose: orange stays for `needs`.
 */
export function Banner({ title, children, icon = 'sparkle', actions, onDismiss }: BannerProps) {
  return (
    <output className="joc-banner joc-fade-in">
      <span className="joc-banner__lead">
        <Icon name={icon} size={14} />
      </span>
      <div className="joc-banner__text">
        <div className="joc-banner__title">{title}</div>
        {children ? <div className="joc-banner__body">{children}</div> : null}
      </div>
      {actions ? <div className="joc-banner__actions">{actions}</div> : null}
      {onDismiss ? (
        <Button variant="ghost" size="sm" icon="x" aria-label="Dismiss" onClick={onDismiss} />
      ) : null}
    </output>
  );
}

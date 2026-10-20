import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Avatar } from './Avatar.tsx';
import { NotificationBell, type NotificationBellProps } from './bell.tsx';
import { CIMark } from './ci.tsx';
import { CopyCommand } from './code.tsx';
import { Button } from './controls.tsx';
import { cx } from './cx.ts';
import { Icon, type IconName } from './Icon.tsx';
import { LogoMark } from './Logo.tsx';
import { StateBadge, StateDot } from './state.tsx';

export interface NavItem {
  id: string;
  label: string;
  href?: string;
  count?: number;
  needs?: number;
}

export interface NavBarProps {
  items: NavItem[];
  value?: string;
  machine?: string;
  machineOffline?: boolean;
  user?: string;
  /** The notifications bell, first in the right-hand cluster. */
  notifications?: NotificationBellProps;
}

export function NavBar({
  items,
  value,
  machine,
  machineOffline,
  user,
  notifications,
}: NavBarProps) {
  return (
    <header className="joc-nav">
      <a className="joc-nav__brand" href="/">
        <LogoMark size={20} />
        JOC
      </a>
      <nav className="joc-nav__links" aria-label="Primary">
        {items.map((it) => {
          const on = it.id === value;
          return (
            <a
              key={it.id}
              href={it.href ?? `/${it.id}`}
              className={cx('joc-nav__link', on && 'is-active')}
              aria-current={on ? 'page' : undefined}
            >
              {it.label}
              {it.needs ? <StateBadge state="needs" label={String(it.needs)} /> : null}
              {it.count != null ? <span className="joc-nav__count">{it.count}</span> : null}
            </a>
          );
        })}
      </nav>
      <div className="joc-nav__right">
        {notifications ? <NotificationBell {...notifications} /> : null}
        {machine ? (
          <span className={cx('joc-nav__machine', machineOffline && 'is-offline')}>
            <span className="joc-nav__link-dot" aria-hidden="true" />
            {machine}
          </span>
        ) : null}
        {user ? <Avatar name={user} size={24} /> : null}
      </div>
    </header>
  );
}

export interface SectionHeaderProps {
  title: string;
  count?: number;
  description?: string;
  size?: 'md' | 'lg';
  children?: ReactNode;
}

export function SectionHeader({ title, count, description, size, children }: SectionHeaderProps) {
  return (
    <div className={cx('joc-sechead', size === 'lg' && 'is-lg')}>
      <div className="joc-sechead__text">
        <h2 className="joc-sechead__title">
          {title}
          {count != null ? <span className="joc-sechead__count">{count}</span> : null}
        </h2>
        {description ? <p className="joc-sechead__desc">{description}</p> : null}
      </div>
      {children ? <div className="joc-sechead__actions">{children}</div> : null}
    </div>
  );
}

export interface EmptyStateProps {
  title: string;
  body?: string;
  icon?: IconName;
  command?: string;
  action?: ReactNode;
  compact?: boolean;
}

export function EmptyState({
  title,
  body,
  icon = 'inbox',
  command,
  action,
  compact,
}: EmptyStateProps) {
  return (
    <div className={cx('joc-empty', compact && 'is-compact')}>
      <span className="joc-empty__glyph">
        <Icon name={icon} size={20} />
      </span>
      <div className="joc-empty__title">{title}</div>
      {body ? <div className="joc-empty__body">{body}</div> : null}
      {command ? <CopyCommand command={command} /> : null}
      {action ? <div className="joc-empty__action">{action}</div> : null}
    </div>
  );
}

/** How long a toast that doesn't persist stays, while the pointer and focus are elsewhere. */
export const TOAST_MS = 5_000;

export interface ToastProps {
  title: string;
  /** A sentence, or a node so a command can be mono. */
  body?: ReactNode;
  tone?: 'neutral' | 'success' | 'error' | 'needs';
  action?: string;
  onAction?: () => void;
  onDismiss?: () => void;
  /**
   * Stays until acted on or dismissed. Defaults to true for `needs`; otherwise the toast calls
   * `onDismiss` after TOAST_MS, paused while the pointer or focus is on it.
   */
  persist?: boolean;
}

export function Toast({
  title,
  body,
  tone = 'neutral',
  action,
  onAction,
  onDismiss,
  persist = tone === 'needs',
}: ToastProps) {
  const [held, setHeld] = useState(false);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    if (persist || held) return;
    const id = setTimeout(() => dismiss.current?.(), TOAST_MS);
    return () => clearTimeout(id);
  }, [persist, held]);
  const lead =
    tone === 'needs' ? (
      <StateDot state="needs" />
    ) : tone === 'success' ? (
      <CIMark status="pass" />
    ) : tone === 'error' ? (
      <CIMark status="fail" />
    ) : (
      <Icon name="sparkle" size={14} />
    );
  const urgent = tone === 'error' || tone === 'needs';
  const Root = urgent ? 'div' : 'output';
  return (
    <Root
      className={cx('joc-toast', `joc-toast--${tone}`, 'joc-fade-in')}
      role={urgent ? 'alert' : undefined}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setHeld(false);
      }}
    >
      <span className="joc-toast__lead">{lead}</span>
      <div className="joc-toast__text">
        <div className="joc-toast__title">{title}</div>
        {body ? <div className="joc-toast__body">{body}</div> : null}
      </div>
      {action ? (
        <Button variant={tone === 'needs' ? 'primary' : 'ghost'} size="sm" onClick={onAction}>
          {action}
        </Button>
      ) : null}
      <Button variant="ghost" size="sm" icon="x" aria-label="Dismiss" onClick={onDismiss} />
    </Root>
  );
}

export type Theme = 'dark' | 'light';

export interface ThemePairProps {
  children: ReactNode | ((theme: Theme) => ReactNode);
  stack?: boolean;
  padding?: number;
}

/** Preview helper: renders its children once per theme, side by side. */
export function ThemePair({ children, stack, padding }: ThemePairProps) {
  const themes: Theme[] = ['dark', 'light'];
  return (
    <div className={cx('joc-pair', stack && 'is-stacked')}>
      {themes.map((t) => (
        <section
          key={t}
          data-theme={t}
          className="joc-pair__pane"
          style={padding != null ? { padding } : undefined}
        >
          <div className="joc-pair__label">{t === 'dark' ? 'Dark' : 'Light'}</div>
          {typeof children === 'function' ? children(t) : children}
        </section>
      ))}
    </div>
  );
}

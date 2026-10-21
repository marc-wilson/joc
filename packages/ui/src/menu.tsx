import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Button } from './controls.tsx';
import { cx } from './cx.ts';
import { Icon, type IconName } from './Icon.tsx';

export interface MenuItem {
  id: string;
  label: string;
  icon?: IconName;
  /** Destructive, such as Delete: drawn in the offline red. */
  danger?: boolean;
  /** Why it can't be chosen now, shown under the label; the item is then disabled. */
  disabledReason?: string;
  /** The current choice, in a menu that picks one: marked with a check. */
  checked?: boolean;
  onSelect: () => void;
}

export interface OverflowMenuProps {
  /** The button's accessible name, e.g. "Session actions". */
  label: string;
  items: MenuItem[];
  /** The button: `sm` (24px) in headers, `md` (30px) at the end of a History row. */
  size?: 'sm' | 'md';
  /** A picker's button shows its current choice and a chevron in place of the "more" glyph. */
  trigger?: string;
  /** Opens above the button, for one near the bottom of the window such as the composer's. */
  above?: boolean;
  /** Drawn as the button in place of the "more" glyph, e.g. the person's avatar. */
  face?: ReactNode;
  /** A line above the items that isn't one of them, e.g. who is signed in. */
  header?: ReactNode;
}

/**
 * A "more" button that opens a short list of actions below it. Arrow keys move, Enter chooses,
 * Escape or a click elsewhere closes, and focus goes back to the button.
 */
export function OverflowMenu({
  label,
  items,
  size = 'sm',
  trigger,
  above,
  face,
  header,
}: OverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>('.joc-menu__item:not(:disabled)')?.focus();
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const close = () => {
    setOpen(false);
    root.current?.querySelector<HTMLElement>('.joc-menu__button')?.focus();
  };

  function onKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (!open) return;
    const all = [
      ...(root.current?.querySelectorAll<HTMLElement>('.joc-menu__item:not(:disabled)') ?? []),
    ];
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      all[(at + step + all.length) % all.length]?.focus();
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  }

  return (
    <div className="joc-menu" ref={root}>
      {face ? (
        <button
          type="button"
          className="joc-menu__button joc-menu__face"
          aria-label={label}
          title={label}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          onClick={() => setOpen(!open)}
          onKeyDown={onKeyDown}
        >
          {face}
        </button>
      ) : (
        <Button
          className="joc-menu__button"
          variant="ghost"
          size={size}
          icon={trigger ? undefined : 'more'}
          aria-label={label}
          title={label}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          onClick={() => setOpen(!open)}
          onKeyDown={onKeyDown}
        >
          {trigger ? (
            <>
              {trigger} <Icon name="chevronDown" size={12} />
            </>
          ) : null}
        </Button>
      )}
      {open ? (
        <div
          className={cx('joc-menu__list', above && 'is-above')}
          role="menu"
          id={id}
          aria-label={label}
          onKeyDown={onKeyDown}
        >
          {header ? <div className="joc-menu__header">{header}</div> : null}
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              aria-current={item.checked || undefined}
              className={cx('joc-menu__item', item.danger && 'is-danger')}
              disabled={!!item.disabledReason}
              onClick={() => {
                close();
                item.onSelect();
              }}
            >
              {item.checked ? (
                <Icon name="check" size={14} />
              ) : item.icon ? (
                <Icon name={item.icon} size={14} />
              ) : (
                <span />
              )}
              <span className="joc-menu__text">
                <span className="joc-menu__label">{item.label}</span>
                {item.disabledReason ? (
                  <span className="joc-menu__reason">{item.disabledReason}</span>
                ) : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Its accessible name, e.g. the session it selects. */
  label: string;
  disabled?: boolean;
  /** Shown on hover, e.g. why it's disabled. */
  title?: string;
}

/** A bare checkbox, for picking rows of a list. */
export function Checkbox({ checked, onChange, label, disabled, title }: CheckboxProps) {
  return (
    <label className={cx('joc-cbox', checked && 'is-on', disabled && 'is-disabled')} title={title}>
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="joc-cbox__box" aria-hidden="true">
        <Icon name="check" size={12} />
      </span>
    </label>
  );
}

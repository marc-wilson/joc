import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { cx } from './cx.ts';
import { Icon } from './Icon.tsx';

export interface SortOption<T extends string = string> {
  id: T;
  /** "State", "Last activity". */
  label: string;
  /** What the order puts first: "Needs you first". */
  desc?: string;
  /** The label's word in the bar, "Sorted by <word>"; the label in lower case by default. */
  word?: string;
}

export interface SortBarProps<T extends string = string> {
  value: T;
  options: SortOption<T>[];
  onChange: (value: T) => void;
  /** The list holds its order (the pointer or focus is in it) with `waiting` rows to move. */
  held?: boolean;
  waiting?: number;
  /** Under the options, e.g. "Applies to every repo group". */
  note?: string;
  /** Says when the menu opens or closes, so the list can hold its order meanwhile. */
  onOpenChange?: (open: boolean) => void;
}

/**
 * One sort control for a whole list, labelled with the current order. Its menu lists the orders
 * as radio items: arrow keys move, Enter chooses, Escape or a click elsewhere closes. While the
 * list holds a re-sort, "Order held, N waiting" fades in at the right.
 */
export function SortBar<T extends string>({
  value,
  options,
  onChange,
  held,
  waiting = 0,
  note,
  onOpenChange,
}: SortBarProps<T>) {
  const [open, setOpenState] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  const current = options.find((o) => o.id === value) ?? options[0];
  // Read when called, so a new function each render doesn't reopen the effect below.
  const told = useRef(onOpenChange);
  told.current = onOpenChange;
  const setOpen = (next: boolean) => {
    setOpenState(next);
    told.current?.(next);
  };

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>('.joc-sortmenu__opt[aria-checked="true"]')?.focus();
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) {
        setOpenState(false);
        told.current?.(false);
      }
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const close = () => {
    setOpen(false);
    root.current?.querySelector<HTMLElement>('.joc-sortbar__btn')?.focus();
  };

  function onKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (!open) return;
    const all = [...(root.current?.querySelectorAll<HTMLElement>('.joc-sortmenu__opt') ?? [])];
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

  const shownWaiting = held && waiting > 0;
  return (
    <div className={cx('joc-sortbar', shownWaiting && 'is-held')} ref={root}>
      <button
        className="joc-sortbar__btn"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
        onKeyDown={onKeyDown}
      >
        Sorted by <strong>{current?.word ?? current?.label.toLowerCase()}</strong>
        <Icon name="chevronDown" size={12} />
      </button>
      {/* Space kept, faded by opacity: the bar never changes size. */}
      <span className="joc-sortbar__held" aria-hidden={shownWaiting ? undefined : 'true'}>
        Order held, {waiting} waiting
      </span>
      {open ? (
        <div
          className="joc-sortmenu"
          role="menu"
          id={id}
          aria-label="Sort sessions"
          onKeyDown={onKeyDown}
        >
          <div className="joc-sortmenu__label">Sort sessions by</div>
          {options.map((o) => (
            <button
              key={o.id}
              className="joc-sortmenu__opt"
              type="button"
              role="menuitemradio"
              aria-checked={o.id === value}
              onClick={() => {
                close();
                if (o.id !== value) onChange(o.id);
              }}
            >
              {o.label}
              {o.desc ? <span className="joc-sortmenu__desc">{o.desc}</span> : null}
            </button>
          ))}
          {note ? <div className="joc-sortmenu__foot">{note}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

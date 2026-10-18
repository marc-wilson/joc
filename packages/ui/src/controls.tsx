import type { SessionState } from '@joc/protocol';
import { type ButtonHTMLAttributes, useState } from 'react';
import { cx } from './cx.ts';
import { Icon, type IconName } from './Icon.tsx';
import { StateDot } from './state.tsx';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  icon?: IconName;
  kbd?: string;
  loading?: boolean;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  kbd,
  loading,
  children,
  className,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={cx(
        'joc-btn',
        `joc-btn--${variant}`,
        `joc-btn--${size}`,
        loading && 'is-loading',
        !children && 'joc-btn--icon',
        className,
      )}
      aria-busy={loading ? 'true' : undefined}
    >
      <span className="joc-btn__content">
        {icon ? <Icon name={icon} size={size === 'sm' ? 14 : 16} /> : null}
        {children ? <span>{children}</span> : null}
        {kbd ? <kbd className="joc-kbd">{kbd}</kbd> : null}
      </span>
      {loading ? <span className="joc-btn__spinner" aria-hidden="true" /> : null}
    </button>
  );
}

export interface TextInputProps {
  label?: string;
  placeholder?: string;
  value?: string;
  icon?: IconName;
  kbd?: string;
  hint?: string;
  error?: string;
  mono?: boolean;
  disabled?: boolean;
  id?: string;
}

export function TextInput({
  label,
  placeholder,
  value,
  icon,
  kbd,
  hint,
  error,
  mono,
  disabled,
  id,
}: TextInputProps) {
  const inputId = id || `in-${(label || 'x').replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div className={cx('joc-field', error && 'is-error', disabled && 'is-disabled')}>
      {label ? (
        <label className="joc-field__label" htmlFor={inputId}>
          {label}
        </label>
      ) : null}
      <div className="joc-input">
        {icon ? <Icon name={icon} size={14} /> : null}
        <input
          id={inputId}
          className={cx(mono && 'is-mono')}
          placeholder={placeholder}
          defaultValue={value}
          disabled={disabled}
          aria-invalid={!!error}
          aria-describedby={`${inputId}-hint`}
        />
        {kbd ? <kbd className="joc-kbd">{kbd}</kbd> : null}
      </div>
      {error || hint ? (
        <div id={`${inputId}-hint`} className="joc-field__hint">
          {error || hint}
        </div>
      ) : null}
    </div>
  );
}

export interface SegmentedControlProps {
  options: { id: string; label: string }[];
  value?: string;
  onChange?: (id: string) => void;
  label?: string;
}

export function SegmentedControl({ options, value, onChange, label }: SegmentedControlProps) {
  const [current, setCurrent] = useState(value ?? options[0]?.id);
  return (
    <div className="joc-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => {
        const on = o.id === current;
        return (
          // biome-ignore lint/a11y/useSemanticElements: a styled segmented button, not a native radio
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            className={cx('joc-seg__opt', on && 'is-on')}
            onClick={() => {
              setCurrent(o.id);
              onChange?.(o.id);
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export interface TabItem {
  id: string;
  label: string;
  count?: number;
  state?: SessionState;
  disabled?: boolean;
}

export interface TabsProps {
  items: TabItem[];
  value?: string;
  onChange?: (id: string) => void;
}

export function Tabs({ items, value, onChange }: TabsProps) {
  const [current, setCurrent] = useState(value ?? items[0]?.id);
  return (
    <div className="joc-tabs" role="tablist">
      {items.map((it) => {
        const on = it.id === current;
        return (
          <button
            key={it.id}
            type="button"
            role="tab"
            aria-selected={on}
            disabled={it.disabled}
            className={cx('joc-tab', on && 'is-active')}
            onClick={() => {
              setCurrent(it.id);
              onChange?.(it.id);
            }}
          >
            {it.state ? <StateDot state={it.state} /> : null}
            <span className="joc-tab__label" data-label={it.label}>
              {it.label}
            </span>
            {it.count != null ? <span className="joc-tab__count">{it.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

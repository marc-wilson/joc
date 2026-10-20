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
  /** Read the value from the surrounding form's `FormData` under this name. */
  name?: string;
  type?: 'text' | 'password';
  autoComplete?: string;
  autoFocus?: boolean;
  /** The text as typed, on every change. */
  onChange?: (value: string) => void;
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
  name,
  type = 'text',
  autoComplete,
  autoFocus,
  onChange,
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
          name={name}
          type={type}
          autoComplete={autoComplete}
          // biome-ignore lint/a11y/noAutofocus: opt-in, for a screen whose only job is this field
          autoFocus={autoFocus}
          className={cx(mono && 'is-mono')}
          placeholder={placeholder}
          defaultValue={value}
          onChange={onChange && ((e) => onChange(e.currentTarget.value))}
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

export interface TextAreaProps {
  label: string;
  placeholder?: string;
  /** The starting text; the field keeps what's typed after that. */
  value?: string;
  hint?: string;
  error?: string;
  mono?: boolean;
  disabled?: boolean;
  id?: string;
  /** Visible lines before it scrolls. */
  rows?: number;
  onChange?: (value: string) => void;
}

/** A field for text that can run to several lines, such as a prompt. Same frame as TextInput. */
export function TextArea({
  label,
  placeholder,
  value,
  hint,
  error,
  mono,
  disabled,
  id,
  rows = 4,
  onChange,
}: TextAreaProps) {
  const inputId = id || `ta-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div className={cx('joc-field', error && 'is-error', disabled && 'is-disabled')}>
      <label className="joc-field__label" htmlFor={inputId}>
        {label}
      </label>
      <textarea
        id={inputId}
        className={cx('joc-textarea', mono && 'is-mono')}
        rows={rows}
        placeholder={placeholder}
        defaultValue={value}
        onChange={onChange && ((e) => onChange(e.currentTarget.value))}
        disabled={disabled}
        aria-invalid={!!error}
        aria-describedby={`${inputId}-hint`}
      />
      {error || hint ? (
        <div id={`${inputId}-hint`} className="joc-field__hint">
          {error || hint}
        </div>
      ) : null}
    </div>
  );
}

export interface SwitchProps {
  label: string;
  /** One line on what it turns on. */
  description?: string;
  checked: boolean;
  disabled?: boolean;
  /** Shown instead of the description, e.g. why it can't be turned on. */
  hint?: string;
  onChange?: (checked: boolean) => void;
}

/** A one-line on/off setting: switch, label, what it does, and On or Off. */
export function Switch({ label, description, checked, disabled, hint, onChange }: SwitchProps) {
  const id = `sw-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div className={cx('joc-switchbar', disabled && 'is-disabled')}>
      <input
        id={id}
        className="joc-switch"
        type="checkbox"
        role="switch"
        aria-checked={checked}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange?.(e.currentTarget.checked)}
      />
      <label htmlFor={id} className="joc-switchbar__label label-strong">
        {label}
      </label>
      <span className="joc-switchbar__desc meta">{hint ?? description}</span>
      <span className="joc-switchbar__state meta">{checked ? 'On' : 'Off'}</span>
    </div>
  );
}

export interface SegmentedControlProps {
  options: { id: string; label: string }[];
  value?: string;
  onChange?: (id: string) => void;
  label?: string;
}

/** Follows `value` when given; otherwise keeps its own choice. */
export function SegmentedControl({ options, value, onChange, label }: SegmentedControlProps) {
  const [own, setCurrent] = useState(value ?? options[0]?.id);
  const current = value ?? own;
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

export interface ChoiceFieldProps {
  label: string;
  /** One line under the choices, e.g. what the setting does. */
  hint?: string;
  options: { id: string; label: string }[];
  value?: string;
  onChange?: (id: string) => void;
}

/** A labelled segmented control, for a setting with a few fixed choices. */
export function ChoiceField({ label, hint, options, value, onChange }: ChoiceFieldProps) {
  return (
    <div className="joc-field joc-choice">
      <span className="joc-field__label">{label}</span>
      <SegmentedControl label={label} options={options} value={value} onChange={onChange} />
      {hint ? <span className="joc-field__hint">{hint}</span> : null}
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

/** Follows `value` when given; otherwise keeps its own choice. */
export function Tabs({ items, value, onChange }: TabsProps) {
  const [own, setCurrent] = useState(value ?? items[0]?.id);
  const current = value ?? own;
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

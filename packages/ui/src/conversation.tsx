import { type ReactNode, useId, useState } from 'react';
import { CIMark } from './ci.tsx';
import { Button } from './controls.tsx';
import { cx } from './cx.ts';
import { Icon } from './Icon.tsx';
import { StateDot } from './state.tsx';

export interface SlashPillProps {
  command: string;
  arg?: string;
  removable?: boolean;
  onRemove?: () => void;
}

export function SlashPill({ command, arg, removable, onRemove }: SlashPillProps) {
  return (
    <span className={cx('joc-slash', removable && 'is-removable')}>
      <span className="joc-slash__name">/{command.replace(/^\//, '')}</span>
      {arg ? <span className="joc-slash__arg">{arg}</span> : null}
      {removable ? (
        <button
          className="joc-slash__x"
          type="button"
          aria-label="Remove command"
          onClick={onRemove}
        >
          <Icon name="x" size={12} />
        </button>
      ) : null}
    </span>
  );
}

export interface ComposerSuggestion {
  command: string;
  description: string;
}

export interface ComposerProps {
  value?: string;
  placeholder?: string;
  suggestions?: ComposerSuggestion[];
  query?: string;
  activeIndex?: number;
  command?: string;
  working?: boolean;
  disabled?: boolean;
  hint?: ReactNode;
}

export function Composer({
  value,
  placeholder = 'Message Claude — / for commands',
  suggestions = [],
  query = '',
  activeIndex = 0,
  command,
  working,
  disabled,
  hint,
}: ComposerProps) {
  return (
    <div className={cx('joc-composer', disabled && 'is-disabled')}>
      {suggestions.length ? (
        <div className="joc-suggest" role="listbox" aria-label="Slash commands">
          <div className="joc-suggest__head">Commands</div>
          {suggestions.map((s, i) => {
            const on = i === activeIndex;
            return (
              <div
                key={s.command}
                role="option"
                aria-selected={on}
                tabIndex={-1}
                className={cx('joc-suggest__item', on && 'is-active')}
              >
                <span className="joc-suggest__cmd">
                  <mark>/{query}</mark>
                  {s.command.replace(/^\//, '').slice(query.length)}
                </span>
                <span className="joc-suggest__desc">{s.description}</span>
                {on ? <kbd className="joc-kbd">↵</kbd> : null}
              </div>
            );
          })}
        </div>
      ) : null}
      <div className="joc-composer__box">
        {command ? <SlashPill command={command} removable /> : null}
        {/* biome-ignore lint/a11y/useSemanticElements: contentEditable so the input can grow and hold rich content */}
        <div
          className={cx('joc-composer__text', !value && 'is-empty')}
          contentEditable={!disabled}
          suppressContentEditableWarning
          data-placeholder={placeholder}
          role="textbox"
          tabIndex={0}
          aria-multiline="true"
        >
          {value}
        </div>
      </div>
      <div className="joc-composer__bar">
        <span className="joc-composer__hint">
          {hint || (
            <>
              <kbd className="joc-kbd">↵</kbd> send <kbd className="joc-kbd">⇧↵</kbd> newline
            </>
          )}
        </span>
        {working ? (
          <Button variant="secondary" size="sm" icon="stop">
            Stop
          </Button>
        ) : null}
        <Button
          variant="primary"
          size="sm"
          icon="send"
          disabled={disabled || !value}
          aria-label="Send"
        />
      </div>
    </div>
  );
}

export interface ToolCallProps {
  name: string;
  target?: string;
  meta?: string;
  status?: 'running' | 'done' | 'error';
  expanded?: boolean;
  children?: ReactNode;
}

export function ToolCall({
  name,
  target,
  meta,
  status = 'done',
  expanded,
  children,
}: ToolCallProps) {
  const [open, setOpen] = useState(!!expanded);
  return (
    <div className={cx('joc-tool', `joc-tool--${status}`, open && 'is-open')}>
      <button
        type="button"
        className="joc-tool__head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
        {status === 'running' ? (
          <span className="joc-sdot joc-sdot--background" role="img" aria-label="Running" />
        ) : (
          <CIMark status={status === 'error' ? 'fail' : 'pass'} size={12} />
        )}
        <span className="joc-tool__name">{name}</span>
        <span className="joc-tool__target">{target}</span>
        {meta ? <span className="joc-tool__meta">{meta}</span> : null}
      </button>
      {open ? <div className="joc-tool__body joc-fade-in">{children}</div> : null}
    </div>
  );
}

export interface MessageProps extends Partial<ToolCallProps> {
  /** Who the message is from. */
  from?: 'user' | 'claude' | 'tool';
  time?: string;
  children?: ReactNode;
}

export function Message({ from = 'claude', time, children, ...tool }: MessageProps) {
  if (from === 'tool') {
    return (
      <ToolCall {...tool} name={tool.name ?? ''}>
        {children}
      </ToolCall>
    );
  }
  return (
    <div className={cx('joc-msg', `joc-msg--${from}`, 'joc-fade-in')}>
      {from === 'claude' ? (
        <div className="joc-msg__who">
          <span className="joc-msg__mark" aria-hidden="true" />
          Claude
          {time ? <span className="joc-msg__time">{time}</span> : null}
        </div>
      ) : null}
      <div className="joc-msg__body">{children}</div>
      {from === 'user' && time ? (
        <div className="joc-msg__time joc-msg__time--user">{time}</div>
      ) : null}
    </div>
  );
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionCardProps {
  question: string;
  options: QuestionOption[];
  header?: string;
  selected?: number;
  otherValue?: string;
  multi?: boolean;
  answered?: boolean;
}

/** Claude's multiple-choice question, with an "Other" free-text answer always last. */
export function QuestionCard({
  question,
  options,
  header,
  selected,
  otherValue,
  multi,
  answered,
}: QuestionCardProps) {
  const [current, setCurrent] = useState<number | null>(selected ?? null);
  const name = useId();
  const all = [...options.map((o) => ({ ...o, other: false })), { label: 'Other', other: true }];
  return (
    // biome-ignore lint/a11y/useSemanticElements: styled card; a fieldset's legend layout fights the design
    <div className={cx('joc-q', answered && 'is-answered')} role="group" aria-label={question}>
      <div className="joc-q__head">
        <StateDot state="needs" />
        <span>{answered ? 'You answered' : header || 'Claude is asking'}</span>
      </div>
      <div className="joc-q__prompt">{question}</div>
      <div className="joc-q__opts" role="radiogroup">
        {all.map((o, i) => {
          const on = current === i;
          return (
            <label key={o.label} className={cx('joc-q__opt', on && 'is-on', o.other && 'is-other')}>
              <input
                type={multi ? 'checkbox' : 'radio'}
                name={name}
                checked={on}
                disabled={answered}
                onChange={() => setCurrent(i)}
              />
              <span className="joc-q__key">{i + 1}</span>
              <span className="joc-q__text">
                <span className="joc-q__label">{o.label}</span>
                {'description' in o && o.description ? (
                  <span className="joc-q__desc">{o.description}</span>
                ) : null}
                {o.other ? (
                  <input
                    className="joc-q__other"
                    placeholder="Type your own answer…"
                    defaultValue={otherValue}
                    disabled={answered}
                    onFocus={() => setCurrent(i)}
                  />
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
      <div className="joc-q__foot">
        <span className="joc-q__hint">Press 1–{all.length} to choose</span>
        <Button variant="primary" size="sm" disabled={current == null || answered}>
          {answered ? 'Answered' : 'Send answer'}
        </Button>
      </div>
    </div>
  );
}

export interface AttachmentProps {
  align?: 'start' | 'end';
  name: string;
  src?: string;
  alt?: string;
  size?: string;
  width?: number;
  height?: number;
  children?: ReactNode;
}

export function Attachment({
  align,
  name,
  src,
  alt,
  size,
  width,
  height,
  children,
}: AttachmentProps) {
  return (
    <figure
      className={cx('joc-attach', align && `joc-attach--${align}`)}
      style={width ? { width } : undefined}
    >
      <div className="joc-attach__frame" style={height ? { height } : undefined}>
        {src ? <img src={src} alt={alt || name} /> : children}
      </div>
      <figcaption className="joc-attach__cap">
        <span className="joc-attach__name">{name}</span>
        {size ? <span className="joc-attach__size">{size}</span> : null}
      </figcaption>
    </figure>
  );
}

/** Conversation column: prose held at the reading measure, code and media wider. */
export function Thread({ children, className }: { children?: ReactNode; className?: string }) {
  return <div className={cx('joc-thread', className)}>{children}</div>;
}

import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { CIMark } from './ci.tsx';
import { Button, CollapseButton } from './controls.tsx';
import { cx } from './cx.ts';
import { Icon } from './Icon.tsx';
import { attachedHint, formatBytes, imageTypeName } from './media.ts';
import { StateDot } from './state.tsx';
import { ImageViewer } from './viewer.tsx';

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

/** Which pasted images the composer takes. Without it, pasting an image does nothing. */
export interface ComposerImageLimits {
  /** MIME types, e.g. `image/png`. */
  types: readonly string[];
  maxBytes: number;
  /** The most images one message carries. */
  max: number;
}

interface Pasted {
  file: File;
  url: string;
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
  /** Lets images be pasted in, within these limits. */
  imageLimits?: ComposerImageLimits;
  /** Called with the trimmed text and any pasted images on Enter or the send button; the box
   * then clears. */
  onSubmit?: (text: string, images: File[]) => void;
}

/** The message box. `value` is its starting text; once typed in, the box owns its text. */
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
  imageLimits,
  onSubmit,
}: ComposerProps) {
  const box = useRef<HTMLDivElement>(null);
  const [empty, setEmpty] = useState(!value);
  const [images, setImages] = useState<Pasted[]>([]);
  const [notice, setNotice] = useState<string>();
  const [viewing, setViewing] = useState<number>();

  // Previews hold object URLs; free whatever is left when the composer goes.
  const shown = useRef(images);
  shown.current = images;
  useEffect(
    () => () => {
      for (const p of shown.current) URL.revokeObjectURL(p.url);
    },
    [],
  );

  function addImages(files: File[]) {
    if (!imageLimits) return;
    const { types, maxBytes, max } = imageLimits;
    const fitting = files.filter((f) => types.includes(f.type) && f.size <= maxBytes);
    const room = max - images.length;
    const taken = fitting.slice(0, Math.max(room, 0));
    setNotice(
      fitting.length < files.length
        ? `Images can be PNG, JPEG, GIF or WebP, up to ${formatBytes(maxBytes)}`
        : taken.length < fitting.length
          ? `Up to ${max} images a message`
          : undefined,
    );
    setImages((list) => [
      ...list,
      ...taken.map((file) => ({ file, url: URL.createObjectURL(file) })),
    ]);
  }

  function removeImage(image: Pasted) {
    URL.revokeObjectURL(image.url);
    setImages((list) => list.filter((p) => p !== image));
    setViewing(undefined);
  }

  const imageName = (p: Pasted, i: number) => p.file.name || `Image ${i + 1}`;
  const attached =
    images.length && imageLimits ? attachedHint(images.length, imageLimits.max, !empty) : '';

  function submit() {
    const el = box.current;
    const text = el?.innerText.trim() ?? '';
    if (!el || (!text && !images.length) || disabled || !onSubmit) return;
    onSubmit(
      text,
      images.map((p) => p.file),
    );
    for (const p of images) URL.revokeObjectURL(p.url);
    setImages([]);
    setViewing(undefined);
    setNotice(undefined);
    el.textContent = '';
    setEmpty(true);
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: dropping images is a shortcut for pasting them
    <div
      className={cx('joc-composer', disabled && 'is-disabled')}
      onDragOver={(e) => {
        if (imageLimits && !disabled && e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!imageLimits || disabled) return;
        e.preventDefault();
        addImages([...e.dataTransfer.files].filter((f) => f.type.startsWith('image/')));
      }}
    >
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
      {images.length ? (
        <ul className="joc-composer__tray" aria-label="Attached images">
          {images.map((p, i) => (
            <li key={p.url}>
              <PastedImage
                name={imageName(p, i)}
                src={p.url}
                size={formatBytes(p.file.size)}
                type={p.file.type}
                onOpen={() => setViewing(i)}
                onRemove={() => removeImage(p)}
              />
            </li>
          ))}
        </ul>
      ) : null}
      {viewing !== undefined ? (
        <ImageViewer
          images={images.map((p, i) => ({
            src: p.url,
            name: imageName(p, i),
            size: formatBytes(p.file.size),
          }))}
          index={viewing}
          onIndex={setViewing}
          onClose={() => setViewing(undefined)}
        />
      ) : null}
      <div className="joc-composer__box">
        {command ? <SlashPill command={command} removable /> : null}
        {/* biome-ignore lint/a11y/useSemanticElements: contentEditable so the input can grow and hold rich content */}
        <div
          ref={box}
          className={cx('joc-composer__text', empty && 'is-empty')}
          contentEditable={!disabled}
          suppressContentEditableWarning
          data-placeholder={placeholder}
          role="textbox"
          tabIndex={0}
          aria-multiline="true"
          aria-label="Message Claude"
          onInput={(e) => setEmpty(!e.currentTarget.innerText.trim())}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter is a new line; leave Enter alone while an IME composes.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          onPaste={(e) => {
            // Paste as plain text, never the source's formatting; images go above the text.
            e.preventDefault();
            const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
            if (files.length) addImages(files);
            const text = e.clipboardData.getData('text/plain');
            if (text) document.execCommand('insertText', false, text);
          }}
        >
          {value}
        </div>
      </div>
      <div className="joc-composer__bar">
        <span className="joc-composer__hint">
          {notice || attached || hint || (
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
          disabled={disabled || (empty && !images.length)}
          aria-label="Send"
          onClick={submit}
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
  /** Claude's messages: shows one line in place of the body. */
  collapsed?: boolean;
  /** Claude's messages: the line a collapsed message shows. */
  preview?: string;
  /** Claude's messages: makes the header a toggle that collapses the message. */
  onToggle?: () => void;
  children?: ReactNode;
}

export function Message({
  from = 'claude',
  time,
  collapsed,
  preview,
  onToggle,
  children,
  ...tool
}: MessageProps) {
  if (from === 'tool') {
    return (
      <ToolCall {...tool} name={tool.name ?? ''}>
        {children}
      </ToolCall>
    );
  }
  const who = (
    <>
      <span className="joc-msg__mark" aria-hidden="true" />
      Claude
      {time ? <span className="joc-msg__time">{time}</span> : null}
    </>
  );
  if (from === 'claude' && onToggle) {
    // The chevron sits in its own gutter, so folding never moves the text sideways.
    return (
      <div className={cx('joc-msg', 'joc-msg--claude', 'joc-fold', 'joc-fade-in')}>
        <CollapseButton
          expanded={!collapsed}
          label={collapsed ? 'Unfold message' : 'Fold message'}
          onClick={onToggle}
        />
        <div className="joc-fold__head">
          <span className="joc-fold__who">Claude</span>
          {time ? <span className="joc-fold__time">{time}</span> : null}
          {collapsed ? <span className="joc-fold__summary joc-fade-in">{preview}</span> : null}
        </div>
        {collapsed ? null : <div className="joc-msg__body joc-fold__body">{children}</div>}
      </div>
    );
  }
  return (
    <div className={cx('joc-msg', `joc-msg--${from}`, 'joc-fade-in')}>
      {from === 'claude' ? <div className="joc-msg__who">{who}</div> : null}
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
  /** Makes the image a button, e.g. to open it full size. */
  onOpen?: () => void;
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
  onOpen,
  children,
}: AttachmentProps) {
  const image = src ? <img src={src} alt={alt || name} /> : children;
  return (
    <figure
      className={cx('joc-attach', align && `joc-attach--${align}`)}
      style={width ? { width } : undefined}
    >
      <div className="joc-attach__frame" style={height ? { height } : undefined}>
        {onOpen ? (
          <button
            type="button"
            className="joc-attach__open"
            aria-label={`Open ${name} full size`}
            onClick={onOpen}
          >
            {image}
          </button>
        ) : (
          image
        )}
      </div>
      <figcaption className="joc-attach__cap">
        <span className="joc-attach__name">{name}</span>
        {size ? <span className="joc-attach__size">{size}</span> : null}
      </figcaption>
    </figure>
  );
}

export interface PastedImageProps {
  name: string;
  src: string;
  /** Its file size, already formatted, e.g. `1.2 MB`. */
  size: string;
  /** Its MIME type, e.g. `image/png`. */
  type: string;
  /** The thumbnail was clicked, e.g. to preview it full size. */
  onOpen?: () => void;
  onRemove?: () => void;
}

/** An image waiting in the composer: a thumbnail, its name, size and type, and a remove button. */
export function PastedImage({ name, src, size, type, onOpen, onRemove }: PastedImageProps) {
  return (
    <div className="joc-pasted">
      <button
        type="button"
        className="joc-pasted__thumb"
        aria-label={`Preview ${name}`}
        onClick={onOpen}
      >
        <img src={src} alt="" />
      </button>
      <div className="joc-pasted__text">
        <span className="joc-pasted__name" title={name}>
          {name}
        </span>
        <span className="joc-pasted__meta">
          {size} · {imageTypeName(type)}
        </span>
      </div>
      <Button variant="ghost" size="sm" icon="x" aria-label={`Remove ${name}`} onClick={onRemove} />
    </div>
  );
}

/** Conversation column: prose held at the reading measure, code and media wider. */
export function Thread({ children, className }: { children?: ReactNode; className?: string }) {
  return <div className={cx('joc-thread', className)}>{children}</div>;
}

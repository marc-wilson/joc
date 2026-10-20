import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { CIMark } from './ci.tsx';
import { CommandList } from './cmdlist.tsx';
import { CopyCommand } from './code.tsx';
import { Button, CollapseButton } from './controls.tsx';
import { cx } from './cx.ts';
import { Icon } from './Icon.tsx';
import { attachedHint, formatBytes, imageTypeName } from './media.ts';
import { type ResumeStep, ResumeSteps } from './resuming.tsx';
import {
  type CommandsStatus,
  type ComposerSuggestion,
  matchSuggestions,
  type SuggestionRow,
  slashQuery,
} from './slash.ts';
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

/** An ended session's composer: Resume in Send's place, then how starting back up goes. */
export interface ComposerResume {
  phase: 'ended' | 'starting' | 'failed';
  /** The box's line while ended or starting: "This session ended 2h ago. Resume it to keep going." */
  text?: ReactNode;
  /** The machine it resumes on. */
  machine: string;
  /** Picks another machine, when there's more than one; shown in place of the machine's name. */
  picker?: ReactNode;
  /** While starting: reached the machine, `claude --resume`, loading the messages. */
  steps?: ResumeStep[];
  /** After a failure: "Couldn't resume on <machine>: <reason>", the fact to fix it, the command. */
  error?: { title: string; detail?: string; command: string };
  onResume?: () => void;
  /** Withdraws it while no machine has taken it yet. */
  onCancel?: () => void;
  /** The request is on its way. */
  busy?: boolean;
}

export interface ComposerProps {
  value?: string;
  placeholder?: string;
  /** The session's slash commands, suggested as you type `/`. */
  suggestions?: ComposerSuggestion[];
  /** Whether `suggestions` holds the session's own commands yet, or the session is offline. */
  commandsStatus?: CommandsStatus;
  working?: boolean;
  disabled?: boolean;
  hint?: ReactNode;
  /** Lets images be pasted in, within these limits. */
  imageLimits?: ComposerImageLimits;
  /** The session ended: the box offers to resume it instead. What you typed is kept, hidden. */
  resume?: ComposerResume;
  /** Called with the trimmed text and any pasted images on Enter or the send button; the box
   * then clears. A picked command leads the text: `/name args`. */
  onSubmit?: (text: string, images: File[]) => void;
}

/**
 * The message box. `value` is its starting text; once typed in, the box owns its text. Typing
 * `/` opens the session's slash commands above it (CommandList); picking one makes it a pill,
 * with its arguments hinted until you type them.
 */
export function Composer({
  value,
  placeholder = 'Message Claude — / for commands',
  suggestions = [],
  commandsStatus = 'ready',
  working,
  disabled: off,
  hint,
  imageLimits,
  resume,
  onSubmit,
}: ComposerProps) {
  // An ended session takes no messages: the box stays, read-only, until it's live again.
  const disabled = off || !!resume;
  const box = useRef<HTMLDivElement>(null);
  const [empty, setEmpty] = useState(!value);
  const [images, setImages] = useState<Pasted[]>([]);
  const [notice, setNotice] = useState<string>();
  const [viewing, setViewing] = useState<number>();
  // The slash command list: what's typed, the command picked, the highlighted row, and whether
  // it was closed (Esc, blur) while a command is still being typed.
  const [text, setText] = useState(value ?? '');
  const [picked, setPicked] = useState<SuggestionRow>();
  const [active, setActive] = useState(0);
  const [closed, setClosed] = useState(true);
  const composer = useRef<HTMLDivElement>(null);
  const listId = useId();
  const optionId = (i: number) => `${listId}-${i}`;

  const query = picked ? undefined : slashQuery(text);
  const open = query !== undefined && !closed;
  const rows = open ? matchSuggestions(suggestions, query) : [];
  const current = Math.max(0, Math.min(active, rows.length - 1));
  const offline = commandsStatus === 'offline';

  // A click anywhere else closes the list, as a blur does.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!composer.current?.contains(e.target as Node)) setClosed(true);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

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

  /** Puts `content` in the box with the caret at its end. */
  function setBox(content: string) {
    const el = box.current;
    if (!el) return;
    el.textContent = content;
    setText(content);
    setEmpty(!content.trim());
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  function pick(row: SuggestionRow) {
    setPicked(row);
    setActive(0);
    setBox('');
  }

  function unpick(restore: string) {
    setPicked(undefined);
    setActive(0);
    setClosed(false);
    setBox(restore);
  }

  function submit() {
    const el = box.current;
    const typed = el?.innerText.trim() ?? '';
    const line = picked ? `/${picked.insert}${typed ? ` ${typed}` : ''}` : typed;
    if (!el || (!line && !images.length) || disabled || !onSubmit) return;
    onSubmit(
      line,
      images.map((p) => p.file),
    );
    for (const p of images) URL.revokeObjectURL(p.url);
    setImages([]);
    setViewing(undefined);
    setNotice(undefined);
    el.textContent = '';
    setEmpty(true);
    setText('');
    setPicked(undefined);
    setActive(0);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    // Leave every key alone while an IME composes.
    if (e.nativeEvent.isComposing) return;
    if (open && !offline && rows.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setActive((current + step + rows.length) % rows.length);
        return;
      }
      const row = rows[current];
      if (row && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) {
        e.preventDefault();
        pick(row);
        return;
      }
    }
    if (open && e.key === 'Escape') {
      e.preventDefault();
      setClosed(true);
      return;
    }
    if (e.key === 'Backspace' && picked && !e.currentTarget.innerText) {
      e.preventDefault();
      unpick(`/${picked.shown}`);
      return;
    }
    // Enter sends, Shift+Enter is a new line.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  const argHint = picked?.command.args;
  let barHint: ReactNode;
  if (picked && argHint && empty) {
    barHint = (
      <span className="joc-arghint">
        <code>/{picked.shown}</code>
        <code>{argHint}</code>
        <span>{picked.command.description}</span>
      </span>
    );
  } else if (picked) {
    barHint = (
      <>
        <kbd className="joc-kbd">↵</kbd> run <kbd className="joc-kbd">⇧↵</kbd> newline
      </>
    );
  } else {
    barHint = (
      <>
        <kbd className="joc-kbd">↵</kbd> send <kbd className="joc-kbd">⇧↵</kbd> newline{' '}
        <kbd className="joc-kbd">/</kbd> commands
      </>
    );
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: dropping images is a shortcut for pasting them
    <div
      ref={composer}
      className={cx(
        'joc-composer',
        disabled && 'is-disabled',
        resume?.phase === 'failed' && 'joc-resume--failed',
      )}
      role={resume?.phase === 'failed' ? 'alert' : undefined}
      aria-busy={resume?.phase === 'starting' || undefined}
      onDragOver={(e) => {
        if (imageLimits && !disabled && e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!imageLimits || disabled) return;
        e.preventDefault();
        addImages([...e.dataTransfer.files].filter((f) => f.type.startsWith('image/')));
      }}
    >
      {open ? (
        <CommandList
          id={listId}
          rows={offline ? [] : rows}
          active={current}
          typed={text}
          status={commandsStatus}
          optionId={optionId}
          onActive={setActive}
          onPick={pick}
        />
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
      {resume?.phase === 'failed' && resume.error ? (
        <div className="joc-resume__error">
          <CIMark status="fail" />
          <div className="joc-resume__error-body">
            <div className="joc-resume__error-title">{resume.error.title}</div>
            {resume.error.detail ? (
              <div className="joc-resume__error-detail">{resume.error.detail}</div>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="joc-composer__box" hidden={resume?.phase === 'failed' && !!resume.error}>
        {resume ? <div className="joc-resume__text">{resume.text}</div> : null}
        {picked && !resume ? (
          <SlashPill command={picked.shown} removable={!disabled} onRemove={() => unpick('/')} />
        ) : null}
        <div
          ref={box}
          hidden={!!resume}
          className={cx('joc-composer__text', empty && 'is-empty', argHint && 'has-args')}
          contentEditable={!disabled}
          suppressContentEditableWarning
          data-placeholder={picked ? argHint || 'Add a note, or press ↵ to run' : placeholder}
          role="combobox"
          tabIndex={disabled ? -1 : 0}
          aria-label="Message Claude"
          // A command name isn't a word to correct.
          spellCheck={query === undefined}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-activedescendant={open && !offline && rows.length ? optionId(current) : undefined}
          aria-disabled={disabled || undefined}
          onInput={(e) => {
            const now = e.currentTarget.innerText;
            setEmpty(!now.trim());
            setText(now);
            setActive(0);
            setClosed(false);
          }}
          onFocus={() => setClosed(false)}
          onBlur={() => {
            // Going offline takes the focus; the list then says why it has no rows.
            if (!disabled) setClosed(true);
          }}
          onKeyDown={onKeyDown}
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
      {resume ? (
        <ResumeBar resume={resume} />
      ) : (
        <div className="joc-composer__bar">
          <span className="joc-composer__hint">{notice || attached || hint || barHint}</span>
          {working ? (
            <Button variant="secondary" size="sm" icon="stop">
              Stop
            </Button>
          ) : null}
          <Button
            variant="primary"
            size="sm"
            icon="send"
            disabled={disabled || (empty && !images.length && !picked)}
            aria-label="Send"
            onClick={submit}
          />
        </div>
      )}
    </div>
  );
}

/** The ended composer's bar: where it runs and Resume, the steps and Cancel, or Try again. */
function ResumeBar({ resume }: { resume: ComposerResume }) {
  const machine = resume.picker ?? <code className="joc-code-inline">{resume.machine}</code>;
  if (resume.phase === 'starting') {
    return (
      <div className="joc-composer__bar">
        <ResumeSteps steps={resume.steps ?? []} />
        {resume.onCancel ? (
          <Button variant="ghost" size="sm" onClick={resume.onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button variant="primary" size="md" disabled>
          Starting…
        </Button>
      </div>
    );
  }
  return (
    <div className="joc-composer__bar">
      {resume.phase === 'failed' && resume.error ? (
        <span className="joc-resume__bar-cmd">
          <CopyCommand command={resume.error.command} />
        </span>
      ) : (
        <span className="joc-resume__note">
          Runs <code className="joc-code-inline">claude --resume</code> on
        </span>
      )}
      {machine}
      <Button variant="primary" size="md" disabled={resume.busy} onClick={resume.onResume}>
        {resume.phase === 'failed' ? 'Try again' : 'Resume'}
      </Button>
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
  /** The question; a command or path goes in as `Code`. */
  question: ReactNode;
  /** Its accessible name, when `question` isn't plain text. */
  label?: string;
  options: QuestionOption[];
  header?: string;
  selected?: number;
  otherValue?: string;
  multi?: boolean;
  /** An "Other" free-text answer, last. On by default; off for a yes-or-no such as a permission. */
  other?: boolean;
  answered?: boolean;
  /**
   * Makes the card answerable: Send answer hands over the chosen label, the chosen labels joined
   * by `, ` (multi), or the words typed under Other. Keys 1–9 choose while focus is in the card.
   */
  onAnswer?: (answer: string) => void;
  /** Sending: the controls hold still and Send waits. */
  busy?: boolean;
  /** One line in the foot in place of the key hint: "Sending…", "Answered in Claude Code". */
  status?: ReactNode;
  /** The send button's label; "Send answer" by default. */
  sendLabel?: string;
}

/** Claude's multiple-choice question, with an "Other" free-text answer always last. */
export function QuestionCard({
  question,
  label,
  options,
  header,
  selected,
  otherValue,
  multi,
  other = true,
  answered,
  onAnswer,
  busy,
  status,
  sendLabel = 'Send answer',
}: QuestionCardProps) {
  const [chosen, setChosen] = useState<number[]>(selected == null ? [] : [selected]);
  const [typed, setTyped] = useState(otherValue ?? '');
  const name = useId();
  const all = [
    ...options.map((o) => ({ ...o, other: false })),
    ...(other ? [{ label: 'Other', other: true }] : []),
  ];
  const otherAt = other ? all.length - 1 : -1;
  const locked = answered || busy;
  const choose = (i: number) => {
    if (locked || i < 0 || i >= all.length) return;
    setChosen((was) =>
      multi ? (was.includes(i) ? was.filter((n) => n !== i) : [...was, i].sort()) : [i],
    );
  };
  const words = typed.trim();
  const answer = chosen
    .map((i) => (i === otherAt ? words : all[i]?.label))
    .filter(Boolean)
    .join(', ');
  const ready = !!answer && !(chosen.includes(otherAt) && !words);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // Typing under Other is words, not keys.
    if ((e.target as HTMLElement).matches('.joc-q__other')) {
      if (e.key === 'Enter' && ready && onAnswer && !locked) {
        e.preventDefault();
        onAnswer(answer);
      }
      return;
    }
    if (!/^[1-9]$/.test(e.key) || Number(e.key) > all.length) return;
    e.preventDefault();
    const i = Number(e.key) - 1;
    choose(i);
    if (i === otherAt) e.currentTarget.querySelector<HTMLInputElement>('.joc-q__other')?.focus();
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: styled card; a fieldset's legend layout fights the design
    <div
      className={cx('joc-q', answered && 'is-answered')}
      role="group"
      aria-label={label ?? (typeof question === 'string' ? question : undefined)}
      onKeyDown={onAnswer ? onKeyDown : undefined}
    >
      <div className="joc-q__head">
        <StateDot state="needs" />
        <span>{answered ? 'You answered' : header || 'Claude is asking'}</span>
      </div>
      <div className="joc-q__prompt">{question}</div>
      <div className="joc-q__opts" role={multi ? undefined : 'radiogroup'}>
        {all.map((o, i) => {
          const on = chosen.includes(i);
          return (
            <label key={o.label} className={cx('joc-q__opt', on && 'is-on', o.other && 'is-other')}>
              <input
                type={multi ? 'checkbox' : 'radio'}
                name={name}
                checked={on}
                disabled={locked}
                onChange={() => choose(i)}
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
                    aria-label="Your own answer"
                    value={typed}
                    disabled={locked}
                    onChange={(e) => setTyped(e.target.value)}
                    onFocus={() => {
                      if (!chosen.includes(i)) choose(i);
                    }}
                  />
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
      <div className="joc-q__foot">
        <span className="joc-q__hint" aria-live="polite">
          {status ?? `Press 1–${all.length} to choose`}
        </span>
        <Button
          variant="primary"
          size="sm"
          disabled={!ready || locked}
          onClick={onAnswer ? () => onAnswer(answer) : undefined}
        >
          {answered ? 'Answered' : busy ? 'Sending…' : sendLabel}
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

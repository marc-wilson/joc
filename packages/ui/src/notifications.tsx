import type { SessionState } from '@joc/protocol';
import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  type UIEvent,
  useEffect,
  useRef,
} from 'react';
import { CIMark, type CIMarkProps } from './ci.tsx';
import { Button, type TabItem, Tabs } from './controls.tsx';
import { cx } from './cx.ts';
import { Icon, type IconName } from './Icon.tsx';
import { StateDot } from './state.tsx';

// The notification center's pieces: the panel the bell opens, its groups and rows, the pill that
// holds new arrivals back while you read, the toast stack, and the settings matrix. Styles are
// in notif.css (prefix `jn-`).

const ROW = 'article.jn-row';

/** Clicks the focused row's control marked `data-row`, as the panel's keys do. */
function press(row: Element | null, which: 'open' | 'dismiss') {
  row?.querySelector<HTMLElement>(`[data-row="${which}"]:not(:disabled)`)?.click();
}

export interface NotificationPanelProps {
  id?: string;
  /** "7 unread", "Nothing unread". */
  summary: string;
  tabs: TabItem[];
  tab: string;
  onTabChange: (id: string) => void;
  /** Dismisses every row but the sessions waiting on you. Disabled when there's none. */
  onClearAll?: () => void;
  onSettings: () => void;
  historyHref: string;
  /** Escape, or a press outside the panel and its bell. Focus goes back to the bell. */
  onClose: () => void;
  /** The bell: a press on it isn't outside, and it takes focus back. */
  anchor: RefObject<HTMLElement | null>;
  /** Pinned to the top of the list: new arrivals waiting (ArrivalsPill). */
  arrivals?: ReactNode;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  onScroll?: (e: UIEvent<HTMLDivElement>) => void;
  bodyRef?: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}

/**
 * The notifications popover, under the nav bar's bell: never a page of its own. It fades in,
 * takes focus, and closes on Escape or a press outside it. Keys: ↑ ↓ move between rows, Enter
 * opens a row, Backspace (or e) dismisses it, 1–9 pick a needs row's answer.
 */
export function NotificationPanel({
  id,
  summary,
  tabs,
  tab,
  onTabChange,
  onClearAll,
  onSettings,
  historyHref,
  onClose,
  anchor,
  arrivals,
  onPointerEnter,
  onPointerLeave,
  onScroll,
  bodyRef,
  children,
}: NotificationPanelProps) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    ref.current?.focus();
    const bell = anchor.current;
    const outside = (e: PointerEvent) => {
      const at = e.target as Node;
      if (ref.current?.contains(at) || anchor.current?.contains(at)) return;
      // A dialog opened from the panel (its settings) isn't outside it.
      if (at instanceof Element && at.closest('dialog')) return;
      close.current();
    };
    document.addEventListener('pointerdown', outside);
    return () => {
      document.removeEventListener('pointerdown', outside);
      // Back to the bell, unless the press went somewhere that took focus.
      const now = document.activeElement;
      if (!now || now === document.body || ref.current?.contains(now)) bell?.focus();
    };
  }, [anchor]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const rows = [...(ref.current?.querySelectorAll<HTMLElement>(ROW) ?? [])];
      if (!rows.length) return;
      e.preventDefault();
      const at = rows.findIndex((r) => r.contains(target));
      const next =
        at < 0
          ? e.key === 'ArrowDown'
            ? 0
            : rows.length - 1
          : Math.min(rows.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)));
      rows[next]?.focus();
      return;
    }
    // The rest act on the focused row itself, not a button inside it.
    if (!target.matches(ROW)) return;
    if (e.key === 'Enter') press(target, 'open');
    else if (e.key === 'e' || e.key === 'Backspace') press(target, 'dismiss');
    else if (/^[1-9]$/.test(e.key)) {
      // A needs row's numbered answer.
      target.querySelector<HTMLElement>(`[data-answer="${e.key}"]:not(:disabled)`)?.click();
    } else return;
    e.preventDefault();
  }

  return (
    <div
      ref={ref}
      id={id}
      className="jn-panel is-anchored joc-fade-in"
      role="dialog"
      aria-label="Notifications"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <div className="jn-panel__head">
        <h2 className="jn-panel__title">Notifications</h2>
        <span className="jn-panel__sub">{summary}</span>
        <span className="jn-spacer" />
        <Button variant="ghost" size="sm" disabled={!onClearAll} onClick={onClearAll}>
          Clear all
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon="settings"
          aria-label="Notification settings"
          title="Notification settings"
          onClick={onSettings}
        />
      </div>
      <div className="jn-panel__tabs">
        <Tabs items={tabs} value={tab} onChange={onTabChange} />
      </div>
      <div className="jn-panel__body" ref={bodyRef} onScroll={onScroll}>
        {arrivals}
        {children}
      </div>
      <div className="jn-panel__foot">
        <span />
        <a className="jn-link" href={historyHref}>
          View history
          <Icon name="chevronRight" size={12} />
        </a>
      </div>
    </div>
  );
}

export interface NotificationGroupProps {
  label: string;
  count?: number;
  /** Quieter words at the end of the header, e.g. "Stays until answered". */
  hint?: string;
  children: ReactNode;
}

/** A sticky group header and its rows. */
export function NotificationGroup({ label, count, hint, children }: NotificationGroupProps) {
  return (
    <section aria-label={label}>
      <div className="jn-group__head">
        {label}
        {count != null ? <span className="jn-group__count">{count}</span> : null}
        {hint ? <span className="jn-group__hint">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}

/** What leads a row: a session state, a CI outcome, or an icon. */
export type NotificationLead =
  | { state: SessionState }
  | { ci: NonNullable<CIMarkProps['status']> }
  | { icon: IconName };

function Lead({ lead }: { lead: NotificationLead }) {
  if ('state' in lead) return <StateDot state={lead.state} />;
  if ('ci' in lead) return <CIMark status={lead.ci} />;
  return <Icon name={lead.icon} size={14} />;
}

export interface NotificationRowProps {
  lead: NotificationLead;
  title: string;
  /** Where it's from, in mono: `atlas-web#12`, `atlas-web`. */
  source: string;
  text?: ReactNode;
  time: string;
  /** Unread rows are heavier and brighter; read rows quieter. Never a dot. */
  unread: boolean;
  /**
   * A session waiting on you: the needs rail and tint, a taller row with `answers` under it, and
   * no dismiss. It leaves when the session stops waiting.
   */
  needs?: boolean;
  /** The needs row's lower line. */
  answers?: ReactNode;
  /** Where the row goes: the whole row opens it, in a new tab when `external`. */
  href: string;
  external?: boolean;
  /** Runs as the row opens, before the browser follows the link (which it may prevent). */
  onOpen?: (e: MouseEvent<HTMLAnchorElement>) => void;
  /** The hover ✕. Left out for a needs row: it goes when answered. */
  onDismiss?: () => void;
  /** Going: it fades out (opacity only), takes no pointer or focus, then is dropped. */
  leaving?: boolean;
  /** Its accessible name, e.g. "Fix auth redirect needs you, 2 minutes ago". */
  label?: string;
}

/**
 * One notification, with one action: the row opens what it's about. Lead glyph, title, source
 * and detail, time; on hover, a single ✕ dismisses it.
 */
export function NotificationRow({
  lead,
  title,
  source,
  text,
  time,
  unread,
  needs,
  answers,
  href,
  external,
  onOpen,
  onDismiss,
  leaving,
  label,
}: NotificationRowProps) {
  const className = cx(
    'jn-row',
    needs && 'jn-row--needs',
    unread && 'is-unread',
    leaving && 'is-leaving',
  );
  return (
    // Rows take focus for the panel's keys.
    <article
      className={className}
      aria-label={label ?? title}
      tabIndex={leaving ? -1 : 0}
      aria-hidden={leaving || undefined}
      inert={leaving || undefined}
    >
      <span className="jn-row__lead" aria-hidden="true">
        <Lead lead={lead} />
      </span>
      <div className="jn-row__main">
        <div className="jn-row__title">
          <a
            className="jn-row__open"
            href={href}
            data-row="open"
            tabIndex={-1}
            onClick={onOpen}
            {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
          >
            {unread && !needs ? <span className="joc-sr">Unread: </span> : null}
            {title}
          </a>
        </div>
        <div className="jn-row__detail">
          <span className="jn-src">{source}</span>
          {text ? <span className="jn-row__text">{text}</span> : null}
        </div>
      </div>
      <div className="jn-row__side">
        <span className="jn-time">{time}</span>
      </div>
      {needs ? (
        answers ? (
          <div className="jn-answers">{answers}</div>
        ) : null
      ) : onDismiss ? (
        <div className="jn-row__hover">
          <Button
            variant="ghost"
            size="sm"
            icon="x"
            aria-label={`Dismiss: ${title}`}
            title="Dismiss (Backspace)"
            data-row="dismiss"
            tabIndex={-1}
            onClick={onDismiss}
          />
        </div>
      ) : null}
    </article>
  );
}

export interface NeedsAnswersProps {
  /** A question's options, numbered 1–9 in order; `mono` for a value such as a domain or path. */
  options?: { label: string; mono?: boolean }[];
  onPick?: (index: number) => void;
  /** "Other…": a free-text answer, given where there's room for one (the session's QuestionCard). */
  onOther?: () => void;
  /** Its label: "Other…" by default, "Answer…" when there are no options to pick. */
  otherLabel?: string;
  /** A permission request: Allow once and Deny. Never a rule for later calls. */
  onAllow?: () => void;
  onDeny?: () => void;
  /** Sending, or sent: the answers hold still. */
  busy?: boolean;
  /** One line in place of the answers: "Sending…", "Answered in Claude Code". */
  status?: ReactNode;
}

/**
 * A needs row's (or a needs toast's) answers: a question's numbered options and Other…, or a
 * permission request's Allow once and Deny. The panel's 1–9 keys press the numbered ones.
 */
export function NeedsAnswers({
  options = [],
  onPick,
  onOther,
  otherLabel = 'Other…',
  onAllow,
  onDeny,
  busy,
  status,
}: NeedsAnswersProps) {
  if (status) return <span className="jn-answers__note joc-fade-in">{status}</span>;
  if (onAllow || onDeny) {
    return (
      <>
        <Button variant="secondary" size="sm" disabled={busy} onClick={onAllow} data-answer="1">
          Allow once
        </Button>
        <Button variant="secondary" size="sm" disabled={busy} onClick={onDeny} data-answer="2">
          Deny
        </Button>
      </>
    );
  }
  const shown = options.slice(0, onOther ? 8 : 9);
  return (
    <>
      {shown.map((o, i) => (
        <button
          key={o.label}
          type="button"
          className={cx('jn-opt', o.mono && 'is-mono')}
          disabled={busy}
          title={o.label}
          data-answer={i + 1}
          onClick={() => onPick?.(i)}
        >
          <span className="jn-opt__n">{i + 1}</span>
          <span className="jn-opt__label">{o.label}</span>
        </button>
      ))}
      {onOther ? (
        <button
          type="button"
          className="jn-opt"
          disabled={busy}
          data-answer={shown.length + 1}
          onClick={onOther}
        >
          <span className="jn-opt__n">{shown.length + 1}</span>
          <span className="jn-opt__label">{otherLabel}</span>
        </button>
      ) : null}
    </>
  );
}

export interface ArrivalsPillProps {
  /** New notifications held back. */
  count: number;
  /** How many of them are a session needing you. */
  needs?: number;
  onShow: () => void;
}

/**
 * "2 new · Show": new notifications wait behind it while you read, rather than landing above
 * the row under your pointer. With a session needing you among them, it says so.
 */
export function ArrivalsPill({ count, needs = 0, onShow }: ArrivalsPillProps) {
  if (!count) return null;
  return (
    <div className="jn-newpill">
      <button type="button" className="jn-bar" onClick={onShow}>
        {needs ? (
          <>
            <StateDot state="needs" />
            {needs} {needs === 1 ? 'needs' : 'need'} you
          </>
        ) : (
          `${count} new`
        )}
        <span className="jn-bar__go">Show</span>
      </button>
    </div>
  );
}

export interface ToastStackProps {
  /** Toasts waiting behind the ones shown. */
  more?: number;
  onOpenMore?: () => void;
  /** The toasts, newest first. */
  children: ReactNode;
}

/**
 * The toasts in the bottom-right corner, newest on top. Existing toasts never move; past three,
 * a bar on top counts the rest.
 */
export function ToastStack({ more = 0, onOpenMore, children }: ToastStackProps) {
  return (
    <section className="jn-toasts is-fixed" aria-label="Notifications">
      {more ? (
        <div className="jn-toasts__more joc-fade-in">
          <span>{more} more waiting</span>
          <button type="button" className="jn-link" onClick={onOpenMore}>
            Open notifications
          </button>
        </div>
      ) : null}
      {children}
    </section>
  );
}

export type NotificationChannel = 'panel' | 'toast' | 'sound' | 'desktop';

export interface NotificationMatrixKind {
  id: string;
  label: string;
  /** Quieter line under the label, when it isn't history only or locked. */
  note?: string;
  channels: Record<NotificationChannel, boolean>;
  /** Always in the panel: its Panel box is checked and can't change. */
  locked?: boolean;
}

export interface NotificationMatrixProps {
  groups: { label: string; kinds: NotificationMatrixKind[] }[];
  soundOff?: boolean;
  onChange: (kind: string, channel: NotificationChannel, on: boolean) => void;
}

const CHANNELS: { id: NotificationChannel; label: string; aria: string }[] = [
  { id: 'panel', label: 'Panel', aria: 'in panel' },
  { id: 'toast', label: 'Toast', aria: 'as toast' },
  { id: 'sound', label: 'Sound', aria: 'with a sound' },
  { id: 'desktop', label: 'Desktop', aria: 'on desktop' },
];

/**
 * Where each kind shows up: Panel, Toast, Sound, Desktop. All off keeps it in the history only.
 * `soundOff` greys the Sound column out while the master switch is off.
 */
export function NotificationMatrix({ groups, soundOff, onChange }: NotificationMatrixProps) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a grid of checkboxes, laid out by notif.css
    <div className="jn-matrix" role="group" aria-label="Where each kind shows up">
      <div className="jn-mx__row jn-mx__head">
        <span>Kind</span>
        {CHANNELS.map((c) => (
          <span key={c.id}>{c.label}</span>
        ))}
      </div>
      {groups.map((g) => (
        <div key={g.label} role="presentation">
          <div className="jn-mx__group">{g.label}</div>
          {g.kinds.map((k) => {
            const off = CHANNELS.every((c) => !k.channels[c.id]);
            const note = k.locked
              ? 'Always in the panel until answered'
              : off
                ? 'History only'
                : k.note;
            return (
              <div key={k.id} className="jn-mx__row">
                <span className="jn-mx__kind">
                  <span>{k.label}</span>
                  {note ? <span className="jn-matrix__note">{note}</span> : null}
                </span>
                {CHANNELS.map((c) => (
                  <span key={c.id}>
                    <input
                      type="checkbox"
                      className="jn-check"
                      checked={k.channels[c.id] || (c.id === 'panel' && !!k.locked)}
                      disabled={(c.id === 'panel' && k.locked) || (c.id === 'sound' && soundOff)}
                      aria-label={`${k.label} ${c.aria}`}
                      onChange={(e) => onChange(k.id, c.id, e.target.checked)}
                    />
                  </span>
                ))}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

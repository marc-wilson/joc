import type { SessionState } from '@joc/protocol';
import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  type UIEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { CIMark, type CIMarkProps } from './ci.tsx';
import { Button, SegmentedControl } from './controls.tsx';
import { cx } from './cx.ts';
import { Icon, type IconName } from './Icon.tsx';
import { EmptyState } from './layout.tsx';
import { StateDot } from './state.tsx';

// The notification center's pieces (v2): the panel the bell opens, its groups and rows, the bar
// that holds new arrivals back while it's open, the toast stack, and the settings grid. Styles
// are in notif.css (prefix `joc-notif-`).

const OPEN = 'a.joc-notif-row__title';

/** Where the panel sits: under its bell, right edges aligned, kept on screen. */
function usePlacement(anchor: RefObject<HTMLElement | null>) {
  const [at, setAt] = useState<{ top: number; right: number }>();
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      const gutter = 8;
      setAt({ top: r.bottom + gutter, right: Math.max(gutter, window.innerWidth - r.right) });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor]);
  return at;
}

export interface NotificationPanelProps {
  id?: string;
  /** Dismisses every row but the sessions waiting on you. Disabled when there's none. */
  onClearAll?: () => void;
  onSettings: () => void;
  /** A quiet line in the header, e.g. why the last dismiss didn't take. */
  note?: string;
  /** A link at the foot, e.g. to the history. */
  foot?: ReactNode;
  /** Escape, or a press outside the panel and its bell. Focus goes back to the bell. */
  onClose: () => void;
  /** The bell: the panel sits under it, a press on it isn't outside, and it takes focus back. */
  anchor: RefObject<HTMLElement | null>;
  /** On top of the list: new arrivals waiting (NotificationNewBar). */
  arrivals?: ReactNode;
  onScroll?: (e: UIEvent<HTMLDivElement>) => void;
  listRef?: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}

/**
 * The notifications popover, under the nav bar's bell: never a page of its own. One list, no
 * tabs. It fades in, takes focus, and closes on Escape or a press outside it. Keys: ↑ ↓ move
 * between rows, Enter opens a row, Backspace (or e) dismisses it, 1–9 press a needs row's answer.
 */
export function NotificationPanel({
  id,
  onClearAll,
  onSettings,
  note,
  foot,
  onClose,
  anchor,
  arrivals,
  onScroll,
  listRef,
  children,
}: NotificationPanelProps) {
  const ref = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const at = usePlacement(anchor);

  useEffect(() => {
    ref.current?.focus();
    const bell = anchor.current;
    const outside = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (ref.current?.contains(target) || anchor.current?.contains(target)) return;
      // A dialog opened from the panel (its settings) isn't outside it.
      if (target instanceof Element && target.closest('dialog')) return;
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

  function onKeyDown(e: KeyboardEvent<HTMLElement>) {
    const target = e.target as HTMLElement;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const rows = [...(ref.current?.querySelectorAll<HTMLElement>(OPEN) ?? [])];
      if (!rows.length) return;
      e.preventDefault();
      // From the row's link, or a button in its row.
      const i = rows.findIndex((r) => r.closest('.joc-notif-row')?.contains(target));
      const next =
        i < 0
          ? e.key === 'ArrowDown'
            ? 0
            : rows.length - 1
          : Math.min(rows.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)));
      rows[next]?.focus();
      return;
    }
    // The rest act on the focused row (its link), not a button inside it. Enter is the link's.
    if (!target.matches(OPEN)) return;
    const row = target.closest('.joc-notif-row');
    if (e.key === 'e' || e.key === 'Backspace') {
      row?.querySelector<HTMLElement>('.joc-notif-row__dismiss')?.click();
    } else if (/^[1-9]$/.test(e.key)) {
      row?.querySelector<HTMLElement>(`[data-answer="${e.key}"]:not(:disabled)`)?.click();
    } else return;
    e.preventDefault();
  }

  return (
    <section
      ref={ref}
      id={id}
      className="joc-notif-panel is-anchored joc-fade-in"
      style={at ? { top: at.top, right: at.right } : { visibility: 'hidden' }}
      role="dialog"
      aria-label="Notifications"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="joc-notif-panel__header">
        <span className="joc-notif-panel__title">Notifications</span>
        {note ? <span className="joc-notif-panel__note">{note}</span> : null}
        <Button variant="ghost" size="sm" disabled={!onClearAll} onClick={onClearAll}>
          Clear all
        </Button>
        <Button variant="ghost" size="sm" onClick={onSettings}>
          Settings
        </Button>
      </div>
      <div className="joc-notif-panel__list" ref={listRef} onScroll={onScroll}>
        {arrivals}
        {children}
      </div>
      {foot ? <div className="joc-notif-panel__foot">{foot}</div> : null}
    </section>
  );
}

/** "All caught up": the panel's empty list. */
export function NotificationEmpty({ title, body }: { title: string; body: string }) {
  return (
    <div className="joc-notif-empty">
      <EmptyState compact icon="bell" title={title} body={body} />
    </div>
  );
}

export interface NotificationGroupProps {
  /** "Needs you", "Activity", a day. */
  label: string;
  /** After the label: "Needs you · 3". */
  count?: number;
  /** Left out: the rows, with no header (Activity, when nothing needs you). */
  bare?: boolean;
  children: ReactNode;
}

/** A sticky group header and its rows. */
export function NotificationGroup({ label, count, bare, children }: NotificationGroupProps) {
  return (
    <section aria-label={label}>
      {bare ? null : (
        <div className="joc-notif-group">{count != null ? `${label} · ${count}` : label}</div>
      )}
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
  /** The second line: repo and branch, the PR's title, a quote. */
  meta?: ReactNode;
  /** Mono, ahead of the meta: a check's name. */
  code?: string;
  time: string;
  /** Read rows drop weight and colour. Never a dot. */
  read?: boolean;
  /** A session waiting on you: the needs ground and rail, and no dismiss. */
  needs?: boolean;
  /** A needs row's inline answer (NeedsAnswers): the row grows to --row-notif-action. */
  actions?: ReactNode;
  /** Where the row goes: the whole row opens it, in a new tab when `external`. */
  href: string;
  external?: boolean;
  /** Runs as the row opens, before the browser follows the link (which it may prevent). */
  onOpen?: (e: MouseEvent<HTMLAnchorElement>) => void;
  /** The ✕ that swaps with the time on hover. Left out for a needs row: it goes when answered. */
  onDismiss?: () => void;
  /** Going: it fades out (opacity only) over --duration-fast, takes no pointer or focus. */
  leaving?: boolean;
  /** Its accessible name, e.g. "Fix auth redirect needs permission, 2 minutes ago". */
  label?: string;
}

/** One notification, with one action: the row opens what it's about. */
export function NotificationRow({
  lead,
  title,
  meta,
  code,
  time,
  read,
  needs,
  actions,
  href,
  external,
  onOpen,
  onDismiss,
  leaving,
  label,
}: NotificationRowProps) {
  const dismissable = !needs && !!onDismiss;
  return (
    <div
      className={cx(
        'joc-notif-row',
        needs && 'is-needs',
        read && 'is-read',
        actions != null && 'joc-notif-row--action',
        dismissable && 'is-dismissable',
        leaving && 'is-leaving',
      )}
      aria-hidden={leaving || undefined}
      inert={leaving || undefined}
    >
      <span className="joc-notif-row__glyph" aria-hidden="true">
        <Lead lead={lead} />
      </span>
      <div className="joc-notif-row__body">
        <a
          className="joc-notif-row__title"
          href={href}
          aria-label={label}
          onClick={onOpen}
          {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
        >
          {title}
        </a>
        <div className="joc-notif-row__meta">
          {code ? <code>{code}</code> : null}
          {meta ? code ? <span>{meta}</span> : meta : null}
        </div>
      </div>
      <div className="joc-notif-row__aside">
        <span className="joc-notif-row__time">{time}</span>
        {dismissable ? (
          <button
            type="button"
            className="joc-notif-row__dismiss"
            aria-label={`Dismiss: ${title}`}
            title="Dismiss (Backspace)"
            tabIndex={-1}
            onClick={onDismiss}
          >
            <Icon name="x" size={14} />
          </button>
        ) : null}
      </div>
      {actions != null ? <div className="joc-notif-row__actions">{actions}</div> : null}
    </div>
  );
}

export interface NeedsAnswersProps {
  /** A permission request: the call, then Deny and Allow. Allow is this call only. */
  command?: string;
  onAllow?: () => void;
  onDeny?: () => void;
  /** A short single-choice question's options, numbered 1–9 for the panel's keys. */
  options?: string[];
  onPick?: (index: number) => void;
  /** "Other…": opens the session at its question, where there's room to type. */
  onOther?: () => void;
  /** Sending: the answers hold still. */
  busy?: boolean;
  /** One line in place of the answers: "Sending…", "Answered in Claude Code". */
  status?: ReactNode;
}

/**
 * A needs row's inline answer: a permission's command with Deny and Allow, or a short question's
 * options and Other…. The panel's 1–9 keys press them in order.
 */
export function NeedsAnswers({
  command,
  onAllow,
  onDeny,
  options = [],
  onPick,
  onOther,
  busy,
  status,
}: NeedsAnswersProps) {
  if (status) return <span className="joc-notif-row__status">{status}</span>;
  if (onAllow || onDeny) {
    return (
      <>
        {command ? (
          <code title={command}>{command}</code>
        ) : (
          <span className="joc-notif-row__spacer" />
        )}
        <Button variant="secondary" size="sm" disabled={busy} onClick={onDeny} data-answer="2">
          Deny
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={busy}
          onClick={onAllow}
          title="Allow this call once"
          data-answer="1"
        >
          Allow
        </Button>
      </>
    );
  }
  return (
    <>
      {options.map((o, i) => (
        <Button
          key={o}
          variant="secondary"
          size="sm"
          disabled={busy}
          data-answer={i + 1}
          onClick={() => onPick?.(i)}
        >
          {o}
        </Button>
      ))}
      <span className="joc-notif-row__spacer" />
      {onOther ? (
        <Button variant="ghost" size="sm" disabled={busy} onClick={onOther}>
          Other…
        </Button>
      ) : null}
    </>
  );
}

export interface NotificationNewBarProps {
  /** New notifications held back while the panel is open. */
  count: number;
  onShow: () => void;
}

/** "2 new — show": arrivals wait here while the panel is open, so nothing moves under you. */
export function NotificationNewBar({ count, onShow }: NotificationNewBarProps) {
  if (!count) return null;
  return (
    <button type="button" className="joc-notif-newbar joc-fade-in" onClick={onShow}>
      {count} new — show
    </button>
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
    <section className="joc-notif-toasts is-fixed" aria-label="Notifications">
      {more ? (
        <div className="joc-notif-toasts__more joc-fade-in">
          <span>{more} more waiting</span>
          <button type="button" className="joc-notif-link" onClick={onOpenMore}>
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
  /** The quieter line under it: "On your PRs". */
  sub: string;
  channels: Record<NotificationChannel, boolean>;
  /** Always in the panel: its Panel box is checked and can't change. */
  locked?: boolean;
}

export interface NotificationMatrixProps {
  kinds: NotificationMatrixKind[];
  /** The master switch for every Sound box. */
  sound: boolean;
  onSound: (on: boolean) => void;
  /** "Send a test": how a notification looks and sounds. */
  onTest: () => void;
  onChange: (kind: string, channel: NotificationChannel, on: boolean) => void;
}

const CHANNELS: { id: NotificationChannel; label: string }[] = [
  { id: 'panel', label: 'Panel' },
  { id: 'toast', label: 'Toast' },
  { id: 'sound', label: 'Sound' },
  { id: 'desktop', label: 'Desktop' },
];

const SOUND = [
  { id: 'on', label: 'On' },
  { id: 'off', label: 'Off' },
];

/**
 * Where each kind shows up: Panel, Toast, Sound, Desktop, under a Sound On/Off master switch.
 * The Sound column is greyed out while the switch is off.
 */
export function NotificationMatrix({
  kinds,
  sound,
  onSound,
  onTest,
  onChange,
}: NotificationMatrixProps) {
  return (
    <div className="joc-notif-settings">
      <div className="joc-notif-settings__sound">
        <div className="joc-notif-settings__kind">
          <span className="joc-notif-settings__name">Sound</span>
          <span className="joc-notif-settings__sub">Master switch for every kind below</span>
        </div>
        <SegmentedControl
          label="Sound"
          options={SOUND}
          value={sound ? 'on' : 'off'}
          onChange={(v) => onSound(v === 'on')}
        />
        <Button variant="secondary" size="sm" onClick={onTest}>
          Send a test
        </Button>
      </div>
      <div className="joc-notif-settings__grid joc-notif-settings__head">
        <span>Kind</span>
        {CHANNELS.map((c) => (
          <span key={c.id} className="joc-notif-settings__cell">
            {c.label}
          </span>
        ))}
      </div>
      {kinds.map((k) => (
        <div key={k.id} className="joc-notif-settings__grid joc-notif-settings__row">
          <div className="joc-notif-settings__kind">
            <span className="joc-notif-settings__name">{k.label}</span>
            <span className="joc-notif-settings__sub">{k.sub}</span>
          </div>
          {CHANNELS.map((c) => {
            const locked = c.id === 'panel' && !!k.locked;
            const muted = c.id === 'sound' && !sound;
            return (
              <span key={c.id} className="joc-notif-settings__cell">
                <input
                  type="checkbox"
                  checked={k.channels[c.id] || locked}
                  disabled={locked || muted}
                  aria-label={`${c.label} for ${k.label}`}
                  title={locked ? 'Always on' : muted ? 'Sound is off' : c.label}
                  onChange={(e) => onChange(k.id, c.id, e.target.checked)}
                />
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

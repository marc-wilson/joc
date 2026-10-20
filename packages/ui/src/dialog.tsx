import { type KeyboardEvent, type ReactNode, useEffect, useRef } from 'react';
import { Button } from './controls.tsx';
import { cx } from './cx.ts';

const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  /** Its accessible name, e.g. the file it shows. */
  label: string;
  /** Leads the header, e.g. a file name. */
  title?: ReactNode;
  /** Quieter detail after the title. */
  meta?: ReactNode;
  /** Controls before the close button. */
  actions?: ReactNode;
  footer?: ReactNode;
  /** Escape, the close button or a click on the scrim. */
  onClose: () => void;
  /** Keys handled while the dialog has focus, after Escape and Tab. */
  onKeyDown?: (e: KeyboardEvent<HTMLDialogElement>) => void;
  className?: string;
  children?: ReactNode;
}

/**
 * A modal frame over the page. Render it to open it: it focuses its first text field, or else
 * its first control, keeps Tab
 * inside, and hands focus back to whatever had it when it goes.
 */
export function Dialog({
  label,
  title,
  meta,
  actions,
  footer,
  onClose,
  onKeyDown,
  className,
  children,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const opener = document.activeElement;
    el.showModal();
    // A field to type in takes focus first; otherwise the first control, the close button.
    const field = el.querySelector<HTMLElement>(
      '.joc-dialog__body :is(textarea, input:not([type="radio"], [type="checkbox"])):not(:disabled)',
    );
    (field ?? el.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    return () => {
      el.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  function keepFocusInside(e: KeyboardEvent<HTMLDialogElement>) {
    const all = [...e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = all[0];
    const last = all.at(-1);
    if (!first || !last) return;
    const at = document.activeElement;
    if (e.shiftKey && (at === first || !e.currentTarget.contains(at))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && at === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <dialog
      ref={ref}
      className={cx('joc-dialog', className)}
      aria-modal="true"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        } else if (e.key === 'Tab') {
          keepFocusInside(e);
        } else {
          onKeyDown?.(e);
        }
      }}
      // The browser's own Escape handling, should a key press reach it.
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="joc-dialog__panel">
        <div className="joc-dialog__head">
          <span className="joc-dialog__title">{title}</span>
          <span className="joc-dialog__meta">{meta}</span>
          {actions}
          <Button variant="ghost" size="sm" icon="x" aria-label="Close" onClick={onClose} />
        </div>
        <div className="joc-dialog__body">{children}</div>
        {footer ? <div className="joc-dialog__foot">{footer}</div> : null}
      </div>
    </dialog>
  );
}

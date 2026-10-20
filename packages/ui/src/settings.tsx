import type { ReactNode } from 'react';
import { CIMark } from './ci.tsx';
import { cx } from './cx.ts';

export type SaveStatus = 'saving' | 'saved' | 'failed' | undefined;

export interface SettingsLayoutProps {
  title?: string;
  /** The sections, in order, for the index. */
  sections: { id: string; label: string }[];
  /** The section the index marks as current. */
  current?: string;
  onNavigate?: (id: string) => void;
  /** How the last change went; settings save as they're made. */
  status?: SaveStatus;
  children: ReactNode;
}

/**
 * A full-width page of settings: an index on the left, the sections on the right. The index
 * stacks above them at narrow widths. Changes save as they're made.
 */
export function SettingsLayout({
  title = 'Settings',
  sections,
  current,
  onNavigate,
  status,
  children,
}: SettingsLayoutProps) {
  return (
    <div className="joc-settings">
      <nav className="joc-settings__nav" aria-label="Settings sections">
        <h1 className="joc-settings__title">{title}</h1>
        {sections.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            className={cx(s.id === current && 'is-current')}
            aria-current={s.id === current ? 'true' : undefined}
            onClick={() => onNavigate?.(s.id)}
          >
            {s.label}
          </a>
        ))}
      </nav>
      <div className="joc-settings__body">
        <div className="joc-settings__status">
          <p>Changes save as you make them.</p>
          <output className="joc-settings__saved">
            {status === 'saved' ? (
              <>
                <CIMark status="pass" size={12} />
                Saved
              </>
            ) : status === 'saving' ? (
              'Saving'
            ) : status === 'failed' ? (
              <>
                <CIMark status="fail" size={12} />
                Couldn't save. Try again.
              </>
            ) : null}
          </output>
        </div>
        {children}
      </div>
    </div>
  );
}

export interface SettingsSectionProps {
  id: string;
  title: string;
  description?: string;
  /** Buttons at the end of its heading, e.g. "Reset to defaults". */
  actions?: ReactNode;
  children?: ReactNode;
}

export function SettingsSection({
  id,
  title,
  description,
  actions,
  children,
}: SettingsSectionProps) {
  const heading = `${id}-title`;
  return (
    <section className="joc-setsec" id={id} aria-labelledby={heading}>
      <div className="joc-setsec__head">
        <div>
          <h2 className="joc-setsec__title" id={heading}>
            {title}
          </h2>
          {description ? <p className="joc-setsec__desc">{description}</p> : null}
        </div>
        {actions ? <div className="joc-setsec__actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

export interface SettingRowProps {
  label: string;
  hint?: string;
  /** The control, at the row's end; it wraps under the text when narrow. */
  children?: ReactNode;
}

/** One setting: its name and a line on it, then its control. */
export function SettingRow({ label, hint, children }: SettingRowProps) {
  return (
    <div className="joc-setrow">
      <div className="joc-setrow__text">
        <span className="joc-setrow__label">{label}</span>
        {hint ? <span className="joc-setrow__hint">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

/** A raised card in a settings section, for fields that need the width. */
export function SettingsCard({ children }: { children: ReactNode }) {
  return <div className="joc-setcard">{children}</div>;
}

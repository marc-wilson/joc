import { Fragment, useLayoutEffect, useRef } from 'react';
import { cx } from './cx.ts';
import type { CommandsStatus, SuggestionRow } from './slash.ts';
import { StateDot } from './state.tsx';

export interface CommandListProps {
  /** The listbox's id, which the composer's text box names in `aria-controls`. */
  id: string;
  rows: SuggestionRow[];
  active: number;
  /** What's typed, `/` included, for the no-match line. */
  typed: string;
  status?: CommandsStatus;
  /** A row's id, for the text box's `aria-activedescendant`. */
  optionId: (index: number) => string;
  onActive: (index: number) => void;
  onPick: (row: SuggestionRow) => void;
}

/**
 * The slash commands above the composer, opening upward from its top-left. Grouped by source
 * with only `/` typed, a flat filtered list after; a fixed footer with the keys and a count.
 * Its height is capped by `--cmdlist-max` and it scrolls inside itself, never the page.
 */
export function CommandList({
  id,
  rows,
  active,
  typed,
  status = 'ready',
  optionId,
  onActive,
  onPick,
}: CommandListProps) {
  const scroll = useRef<HTMLDivElement>(null);

  // Keeps the active row in view, as `block: nearest` would, but moving only this list.
  useLayoutEffect(() => {
    const box = scroll.current;
    const row = box?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!box || !row) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < box.scrollTop) box.scrollTop = top;
    else if (bottom > box.scrollTop + box.clientHeight) {
      box.scrollTop = bottom - box.clientHeight;
    }
  });

  const offline = status === 'offline';
  const loading = status === 'loading';
  const count = loading
    ? `${rows.length} so far`
    : rows.length === 1
      ? '1 command'
      : `${rows.length} commands`;

  return (
    <div
      className="joc-cmdlist"
      role="listbox"
      id={id}
      aria-label="Slash commands"
      aria-busy={loading || undefined}
    >
      <div className="joc-cmdlist__scroll" ref={scroll}>
        {offline ? (
          <div className="joc-cmdlist__note" role="status">
            <StateDot state="offline" />
            Session went offline. Commands come back when it reconnects.
          </div>
        ) : (
          <>
            {rows.map((row, i) => {
              const on = i === active;
              return (
                <Fragment key={`${row.command.source}:${row.insert}`}>
                  {row.group ? (
                    <div className="joc-cmdlist__group" role="presentation">
                      {row.group}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    id={optionId(i)}
                    className={cx('joc-cmdlist__item', on && 'is-active')}
                    role="option"
                    aria-selected={on}
                    tabIndex={-1}
                    onMouseEnter={() => {
                      if (!on) onActive(i);
                    }}
                    // Focus stays in the composer.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onPick(row)}
                  >
                    <span className="joc-cmdlist__name">
                      /{row.ns ? <span className="joc-cmdlist__ns">{row.ns}</span> : null}
                      {row.pre}
                      {row.hit ? <mark>{row.hit}</mark> : null}
                      {row.post}
                      {row.command.args ? (
                        <span className="joc-cmdlist__args">{row.command.args}</span>
                      ) : null}
                    </span>
                    <span className="joc-cmdlist__desc">{row.command.description}</span>
                    {row.command.terminal ? (
                      <span className="joc-cmdlist__term">Opens in the terminal</span>
                    ) : null}
                    <span
                      className={cx(
                        'joc-cmdlist__src',
                        row.command.source === 'plugin' && 'is-plugin',
                      )}
                    >
                      {row.label}
                    </span>
                  </button>
                </Fragment>
              );
            })}
            {!rows.length && !loading ? (
              <div className="joc-cmdlist__note" role="status">
                No commands match <code>{typed}</code>
              </div>
            ) : null}
            {loading ? (
              <>
                <div className="joc-cmdlist__ph" aria-hidden="true">
                  <span className="joc-cmdlist__bar" style={{ width: 120 }} />
                  <span className="joc-cmdlist__bar" style={{ width: 220 }} />
                  <span className="joc-cmdlist__bar" style={{ width: 56, marginLeft: 'auto' }} />
                </div>
                <div className="joc-cmdlist__note" style={{ color: 'var(--text-tertiary)' }}>
                  Loading project, user and plugin commands from this session
                </div>
              </>
            ) : null}
          </>
        )}
      </div>
      <div className="joc-cmdlist__foot">
        {offline ? (
          <span>
            <kbd className="joc-kbd">Esc</kbd>close
          </span>
        ) : rows.length ? (
          <>
            <span>
              <kbd className="joc-kbd">↑↓</kbd>move
            </span>
            <span>
              <kbd className="joc-kbd">Tab</kbd>complete
            </span>
            <span>
              <kbd className="joc-kbd">Esc</kbd>close
            </span>
          </>
        ) : (
          <>
            <span>
              <kbd className="joc-kbd">Esc</kbd>close
            </span>
            <span>
              <kbd className="joc-kbd">↵</kbd>send as a message
            </span>
          </>
        )}
        {offline ? null : (
          <span className="joc-cmdlist__count" aria-live="polite">
            {count}
          </span>
        )}
      </div>
    </div>
  );
}

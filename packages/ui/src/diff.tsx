import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Button, SegmentedControl } from './controls.tsx';
import { cx } from './cx.ts';
import { Icon } from './Icon.tsx';

export interface ViewedCheckboxProps {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
}

/** Follows `checked` when given; otherwise keeps its own state. */
export function ViewedCheckbox({ checked, onChange }: ViewedCheckboxProps) {
  const [own, setOn] = useState(!!checked);
  const on = checked ?? own;
  return (
    <label className={cx('joc-viewed', on && 'is-on')}>
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => {
          setOn(e.target.checked);
          onChange?.(e.target.checked);
        }}
      />
      <span className="joc-viewed__box" aria-hidden="true">
        <Icon name="check" size={12} />
      </span>
      <span>Viewed</span>
    </label>
  );
}

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

const FILE_STATUS: Record<FileStatus, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
};

export interface FileTreeItem {
  name: string;
  depth?: number;
  type?: 'dir' | 'file';
  status?: FileStatus;
  viewed?: boolean;
  comments?: number;
  active?: boolean;
}

export interface FileTreeProps {
  items: FileTreeItem[];
  onSelect?: (item: FileTreeItem, index: number) => void;
}

export function FileTree({ items, onSelect }: FileTreeProps) {
  return (
    <div className="joc-tree" role="tree">
      {items.map((it, i) => {
        const dir = it.type === 'dir';
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: a flattened tree repeats names at different depths
            key={i}
            role="treeitem"
            tabIndex={-1}
            aria-selected={!!it.active}
            className={cx('joc-tree__row', it.active && 'is-active', it.viewed && 'is-viewed')}
            style={{ paddingLeft: 8 + (it.depth ?? 0) * 14 }}
            onClick={() => onSelect?.(it, i)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSelect?.(it, i);
            }}
          >
            <Icon name={dir ? 'folder' : 'file'} size={14} />
            <span className="joc-tree__name">{it.name}</span>
            {it.comments ? (
              <span className="joc-tree__comments">
                <Icon name="comment" size={12} />
                {it.comments}
              </span>
            ) : null}
            {!dir && it.viewed ? (
              <span className="joc-tree__viewed" title="Viewed">
                <Icon name="check" size={12} />
              </span>
            ) : null}
            {!dir && it.status ? (
              <span
                className={cx('joc-tree__status', `joc-tree__status--${it.status}`)}
                title={it.status}
              >
                {FILE_STATUS[it.status]}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export interface FileTreePanelProps {
  items: FileTreeItem[];
  title?: string;
  summary?: ReactNode;
  width?: number;
  minWidth?: number;
  maxWidth?: number;
  collapsed?: boolean;
  onSelect?: (item: FileTreeItem, index: number) => void;
}

/** The diff's file tree: drag or arrow keys to resize, collapses to a strip of status marks. */
export function FileTreePanel({
  items,
  title = 'Files',
  summary,
  width = 260,
  minWidth = 180,
  maxWidth = 480,
  collapsed: collapsedProp,
  onSelect,
}: FileTreePanelProps) {
  const [w, setW] = useState(width);
  const [collapsed, setCollapsed] = useState(!!collapsedProp);
  useEffect(() => setCollapsed(!!collapsedProp), [collapsedProp]);
  useEffect(() => setW(width), [width]);

  const clamp = (v: number) => Math.max(minWidth, Math.min(maxWidth, v));

  function startDrag(e: PointerEvent) {
    const x0 = e.clientX;
    const w0 = w;
    const move = (ev: globalThis.PointerEvent) => setW(clamp(w0 + ev.clientX - x0));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    e.preventDefault();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowLeft') {
      setW(clamp(w - 16));
      e.preventDefault();
    }
    if (e.key === 'ArrowRight') {
      setW(clamp(w + 16));
      e.preventDefault();
    }
  }

  const label = title === 'Files' ? 'Changed files' : title;
  const files = items.filter((it) => it.type !== 'dir');

  if (collapsed) {
    return (
      <nav className="joc-ftp is-collapsed" aria-label={label}>
        <button
          type="button"
          className="joc-ftp__toggle"
          aria-label="Show file tree"
          aria-expanded="false"
          onClick={() => setCollapsed(false)}
        >
          <Icon name="folder" size={14} />
        </button>
        <span className="joc-ftp__count">{files.length}</span>
        <div className="joc-ftp__marks">
          {files.map((f, i) => (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: file names can repeat across folders
              key={i}
              type="button"
              title={f.name}
              aria-label={f.name + (f.viewed ? ' (viewed)' : '')}
              aria-current={f.active ? 'true' : undefined}
              onClick={() => onSelect?.(f, items.indexOf(f))}
              className={cx(
                'joc-ftp__mark',
                `joc-tree__status--${f.status ?? 'modified'}`,
                f.active && 'is-active',
                f.viewed && 'is-viewed',
              )}
            >
              {FILE_STATUS[f.status ?? 'modified']}
            </button>
          ))}
        </div>
      </nav>
    );
  }

  return (
    <nav className="joc-ftp" style={{ width: w }} aria-label={label}>
      <div className="joc-ftp__head">
        <span className="joc-ftp__title">{title}</span>
        {summary ? <span className="joc-ftp__summary">{summary}</span> : null}
        <button
          type="button"
          className="joc-ftp__toggle"
          aria-label="Collapse file tree"
          aria-expanded="true"
          onClick={() => setCollapsed(true)}
        >
          <Icon name="chevronRight" size={14} className="joc-flip" />
        </button>
      </div>
      <div className="joc-ftp__body">
        <FileTree items={items} onSelect={onSelect} />
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: an <hr> can't be dragged or focused as a resize handle */}
      <div
        className="joc-ftp__handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize file tree"
        aria-valuenow={w}
        aria-valuemin={minWidth}
        aria-valuemax={maxWidth}
        tabIndex={0}
        onPointerDown={startDrag}
        onKeyDown={onKey}
      />
    </nav>
  );
}

export function DiffStat({
  additions = 0,
  deletions = 0,
}: {
  additions?: number;
  deletions?: number;
}) {
  return (
    <span className="joc-pr__diffstat">
      <span className="joc-add">+{additions}</span>
      <span className="joc-del">−{deletions}</span>
    </span>
  );
}

export interface DiffFileHeaderProps {
  path: string;
  additions?: number;
  deletions?: number;
  mode?: 'unified' | 'split';
  viewed?: boolean;
  showToggle?: boolean;
  onModeChange?: (mode: 'unified' | 'split') => void;
  onViewedChange?: (viewed: boolean) => void;
}

export function DiffFileHeader({
  path,
  additions,
  deletions,
  mode = 'unified',
  viewed,
  showToggle = true,
  onModeChange,
  onViewedChange,
}: DiffFileHeaderProps) {
  return (
    <div className="joc-dfh">
      <Icon name="chevronDown" size={12} />
      <span className="joc-dfh__path">{path}</span>
      <DiffStat additions={additions} deletions={deletions} />
      <span className="joc-dfh__spacer" />
      {showToggle ? (
        <SegmentedControl
          label="Diff layout"
          value={mode}
          options={[
            { id: 'unified', label: 'Unified' },
            { id: 'split', label: 'Split' },
          ]}
          onChange={(id) => onModeChange?.(id as 'unified' | 'split')}
        />
      ) : null}
      <ViewedCheckbox checked={viewed} onChange={onViewedChange} />
    </div>
  );
}

type LineKind = 'add' | 'del' | 'ctx';

const SIGN: Record<LineKind, string> = { add: '+', del: '−', ctx: ' ' };

export interface DiffLineProps {
  kind?: LineKind | 'hunk';
  oldNo?: number;
  newNo?: number;
  commented?: boolean;
  onComment?: () => void;
  children?: ReactNode;
}

export function DiffLine({
  kind = 'ctx',
  oldNo,
  newNo,
  commented,
  onComment,
  children,
}: DiffLineProps) {
  if (kind === 'hunk') {
    return (
      <div className="joc-dl joc-dl--hunk">
        <span className="joc-dl__no" />
        <span className="joc-dl__no" />
        <span className="joc-dl__code">{children}</span>
      </div>
    );
  }
  return (
    <div className={cx('joc-dl', `joc-dl--${kind}`, commented && 'has-comment')}>
      <span className="joc-dl__no">{oldNo}</span>
      <span className="joc-dl__no">{newNo}</span>
      <span className="joc-dl__code">
        <span className="joc-dl__sign" aria-hidden="true">
          {SIGN[kind]}
        </span>
        {children}
      </span>
      <button
        className="joc-dl__add"
        type="button"
        aria-label="Comment on line"
        onClick={onComment}
      >
        <Icon name="plus" size={12} />
      </button>
    </div>
  );
}

export interface DiffSide {
  kind?: LineKind;
  no?: number;
  text: ReactNode;
}

function SplitSide({ side }: { side: DiffSide | null }) {
  if (!side) {
    return (
      <div className="joc-dsplit__side is-empty">
        <span className="joc-dl__no" />
        <span className="joc-dl__code" />
      </div>
    );
  }
  const kind = side.kind ?? 'ctx';
  return (
    <div className={cx('joc-dsplit__side', `joc-dl--${kind}`)}>
      <span className="joc-dl__no">{side.no}</span>
      <span className="joc-dl__code">
        <span className="joc-dl__sign" aria-hidden="true">
          {SIGN[kind]}
        </span>
        {side.text}
      </span>
    </div>
  );
}

export function DiffSplitRow({ left, right }: { left: DiffSide | null; right: DiffSide | null }) {
  return (
    <div className="joc-dsplit">
      <SplitSide side={left} />
      <SplitSide side={right} />
    </div>
  );
}

export interface InlineCommentProps {
  author?: string;
  time?: string;
  body?: string;
  pending?: boolean;
  composing?: boolean;
  /** While composing: close without keeping the comment. */
  onCancel?: () => void;
  /** While composing: keep the comment for the review, sent later with the rest. */
  onAdd?: (text: string) => void;
  /** While composing: send this one comment to Claude now. */
  onSend?: (text: string) => void;
}

export function InlineComment({
  author,
  time,
  body,
  pending,
  composing,
  onCancel,
  onAdd,
  onSend,
}: InlineCommentProps) {
  const input = useRef<HTMLTextAreaElement>(null);
  const withText = (fn?: (text: string) => void) => () => {
    const text = input.current?.value.trim();
    if (text) fn?.(text);
  };
  return (
    <div className={cx('joc-icmt', pending && 'is-pending', composing && 'is-composing')}>
      {composing ? (
        <>
          <textarea
            ref={input}
            className="joc-icmt__input"
            placeholder="Leave a comment — Claude will see it on its next turn"
            defaultValue={body}
            rows={3}
            // biome-ignore lint/a11y/noAutofocus: opened by the person's own click on a line
            autoFocus
          />
          <div className="joc-icmt__actions">
            <Button variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="secondary" size="sm" onClick={withText(onAdd)}>
              Add to review
            </Button>
            <Button variant="primary" size="sm" onClick={withText(onSend)}>
              Send to Claude
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="joc-icmt__head">
            <span className="joc-icmt__avatar" aria-hidden="true">
              {(author || '?').slice(0, 1).toUpperCase()}
            </span>
            <span className="joc-icmt__author">{author}</span>
            <span className="joc-icmt__time">{time}</span>
            {pending ? <span className="joc-tag">Pending</span> : null}
          </div>
          <div className="joc-icmt__body">{body}</div>
        </>
      )}
    </div>
  );
}

export interface ReviewBarProps {
  comments?: number;
  viewed?: number;
  total?: number;
  sendLabel?: string;
  onSend?: () => void;
  onDiscard?: () => void;
  /** Shown only when given: needs the session's PR. */
  onCommentOnPr?: () => void;
}

export function ReviewBar({
  comments = 0,
  viewed = 0,
  total = 0,
  sendLabel = 'Send review to Claude',
  onSend,
  onDiscard,
  onCommentOnPr,
}: ReviewBarProps) {
  return (
    <div className="joc-reviewbar">
      <span className="joc-reviewbar__stat">
        <Icon name="comment" size={14} />
        {comments} comments
      </span>
      <span className="joc-reviewbar__stat">
        <Icon name="check" size={14} />
        {viewed} of {total} files viewed
      </span>
      {/* biome-ignore lint/a11y/useSemanticElements: native <meter> can't take the token styling */}
      <span
        className="joc-reviewbar__meter"
        role="meter"
        aria-valuenow={viewed}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-label="Files viewed"
      >
        <span style={{ width: `${total ? (100 * viewed) / total : 0}%` }} />
      </span>
      <span className="joc-reviewbar__spacer" />
      <Button variant="ghost" size="md" disabled={!comments} onClick={onDiscard}>
        Discard
      </Button>
      {onCommentOnPr ? (
        <Button variant="secondary" size="md" icon="pr" onClick={onCommentOnPr}>
          Comment on PR
        </Button>
      ) : null}
      <Button variant="primary" size="md" icon="send" disabled={!comments} onClick={onSend}>
        {sendLabel}
      </Button>
    </div>
  );
}

import {
  DiffFileHeader,
  DiffLine,
  DiffSplitRow,
  EmptyState,
  type FileTreeItem,
  FileTreePanel,
  InlineComment,
  ReviewBar,
} from '@joc/ui';
import { Fragment, useState } from 'react';
import type { DiffFile, DiffLine as Line } from './diff.ts';
import { splitRows } from './diff.ts';
import type { Changes } from './hooks.ts';
import { store, stored, usePref } from './prefs.ts';

type Mode = 'unified' | 'split';

interface Comment {
  id: string;
  path: string;
  line: Line;
  text: string;
}

const lineKey = (path: string, l: Line) => `${path}:${l.kind}:${l.oldNo ?? ''}:${l.newNo ?? ''}`;

/** Folders and files in path order, each file under its folders, for the tree panel. */
function treeItems(files: DiffFile[], viewed: Set<string>, active?: string) {
  const items: (FileTreeItem & { fileIndex?: number })[] = [];
  const seen = new Set<string>();
  const order = files.map((f, i) => ({ f, i })).sort((a, b) => a.f.path.localeCompare(b.f.path));
  for (const { f, i } of order) {
    const parts = f.path.split('/');
    for (let d = 0; d < parts.length - 1; d++) {
      const dir = parts.slice(0, d + 1).join('/');
      if (!seen.has(dir)) {
        seen.add(dir);
        items.push({ name: parts[d] ?? '', depth: d, type: 'dir' });
      }
    }
    items.push({
      name: parts.at(-1) ?? f.path,
      depth: parts.length - 1,
      type: 'file',
      status: f.status,
      viewed: viewed.has(f.path),
      active: f.path === active,
      fileIndex: i,
    });
  }
  return items;
}

/** How a review reads when it lands in the session as a prompt. */
function reviewPrompt(comments: Comment[]): string {
  const parts = comments.map((c) => {
    const no = c.line.newNo ?? c.line.oldNo;
    const quoted = c.line.text.trim() ? `\n> ${c.line.text.trim()}` : '';
    return `**${c.path}:${no}**${quoted}\n${c.text}`;
  });
  return `Here's my review of your changes:\n\n${parts.join('\n\n')}`;
}

interface Props {
  sessionId: string;
  changes: Changes;
  onSend: (text: string) => void;
}

/** A PR-style review of the session's changes; comments go back to the session as a prompt. */
export function ChangesView({ sessionId, changes, onSend }: Props) {
  const [mode, setMode] = useState<Mode>(() => stored('joc:diff-mode', 'unified'));
  const [viewed, setViewed] = useState(
    () => new Set(stored<string[]>(`joc:viewed:${sessionId}`, [])),
  );
  // A file folds when marked viewed; its chevron folds or opens it either way.
  const [folded, setFolded] = usePref<Record<string, boolean>>(`joc:folded:${sessionId}`, {});
  const isFolded = (path: string) => folded[path] ?? viewed.has(path);
  const [comments, setComments] = useState<Comment[]>([]);
  const [composing, setComposing] = useState<{ path: string; line: Line }>();
  const [active, setActive] = useState<string>();

  if (changes.status === 'loading') return null;
  if (changes.status === 'none') {
    return (
      <EmptyState
        title="No changes yet"
        body="This session's changes show here at the end of its next turn."
      />
    );
  }
  const { files, base, truncated } = changes;
  if (!files.length) {
    return <EmptyState title="No changes" body={`Nothing differs from ${base}.`} />;
  }

  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);

  function changeMode(next: Mode) {
    setMode(next);
    store('joc:diff-mode', next);
  }
  function toggleViewed(path: string, on: boolean) {
    const next = new Set(viewed);
    if (on) next.add(path);
    else next.delete(path);
    setViewed(next);
    store(`joc:viewed:${sessionId}`, [...next]);
    const { [path]: _, ...rest } = folded;
    setFolded(rest);
  }
  function addComment(path: string, line: Line, text: string) {
    setComments((list) => [...list, { id: crypto.randomUUID(), path, line, text }]);
    setComposing(undefined);
  }

  // Comments (and the open composer) under the line they're about.
  function threadFor(path: string, lines: (Line | null)[]) {
    const keys = new Set(lines.filter((l): l is Line => !!l).map((l) => lineKey(path, l)));
    const here = comments.filter((c) => keys.has(lineKey(c.path, c.line)));
    const open = composing && composing.path === path && keys.has(lineKey(path, composing.line));
    if (!here.length && !open) return null;
    return (
      <>
        {here.map((c) => (
          <InlineComment key={c.id} author="You" body={c.text} pending />
        ))}
        {open && composing ? (
          <InlineComment
            composing
            onCancel={() => setComposing(undefined)}
            onAdd={(text) => addComment(path, composing.line, text)}
            onSend={(text) => {
              onSend(reviewPrompt([{ id: '', path, line: composing.line, text }]));
              setComposing(undefined);
            }}
          />
        ) : null}
      </>
    );
  }

  return (
    <div className="app-changes">
      <FileTreePanel
        items={treeItems(files, viewed, active)}
        summary={`${files.length} files · +${additions} −${deletions} vs ${base}`}
        onSelect={(item) => {
          const index = (item as { fileIndex?: number }).fileIndex;
          if (index === undefined) return;
          setActive(files[index]?.path);
          document.getElementById(`diff-file-${index}`)?.scrollIntoView({ block: 'start' });
        }}
      />
      <div className="app-changes__main">
        <div className="app-changes__scroll">
          {truncated ? (
            <p className="app-changes__note">
              This diff is too large to show whole, so some files are left out.
            </p>
          ) : null}
          {files.map((file, index) => (
            <section key={file.path} id={`diff-file-${index}`} className="app-changes__file">
              <DiffFileHeader
                path={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                additions={file.additions}
                deletions={file.deletions}
                mode={mode}
                onModeChange={changeMode}
                viewed={viewed.has(file.path)}
                onViewedChange={(on) => toggleViewed(file.path, on)}
                collapsed={isFolded(file.path)}
                onToggle={() => setFolded({ ...folded, [file.path]: !isFolded(file.path) })}
              />
              {isFolded(file.path) ? null : (
                <div className="joc-diff">
                  {file.binary ? <DiffLine kind="hunk">Binary file not shown</DiffLine> : null}
                  {file.hunks.map((hunk) => (
                    <Fragment key={hunk.header}>
                      <DiffLine kind="hunk">{hunk.header}</DiffLine>
                      {mode === 'unified'
                        ? hunk.lines.map((line) => (
                            <Fragment key={lineKey(file.path, line)}>
                              <DiffLine
                                kind={line.kind}
                                oldNo={line.oldNo}
                                newNo={line.newNo}
                                onComment={() => setComposing({ path: file.path, line })}
                              >
                                {line.text}
                              </DiffLine>
                              {threadFor(file.path, [line])}
                            </Fragment>
                          ))
                        : splitRows(hunk.lines).map((row) => {
                            const key = `${row.left ? lineKey(file.path, row.left) : ''}|${row.right ? lineKey(file.path, row.right) : ''}`;
                            const side = (l: Line | null) =>
                              l
                                ? {
                                    kind: l.kind,
                                    no: l.kind === 'del' ? l.oldNo : l.newNo,
                                    text: l.text,
                                  }
                                : null;
                            return (
                              <Fragment key={key}>
                                <DiffSplitRow left={side(row.left)} right={side(row.right)} />
                                {threadFor(file.path, [row.left, row.right])}
                              </Fragment>
                            );
                          })}
                    </Fragment>
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
        <ReviewBar
          comments={comments.length}
          viewed={files.filter((f) => viewed.has(f.path)).length}
          total={files.length}
          onDiscard={() => setComments([])}
          onSend={() => {
            onSend(reviewPrompt(comments));
            setComments([]);
          }}
        />
      </div>
    </div>
  );
}

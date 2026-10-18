// Parses `git diff` output into files, hunks and numbered lines.

export type DiffLineKind = 'add' | 'del' | 'ctx';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export type DiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface DiffFile {
  path: string;
  oldPath?: string;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  hunks: DiffHunk[];
}

const unquote = (p: string) => p.replace(/^"(.*)"$/, '$1');
const strip = (p: string) => unquote(p).replace(/^[ab]\//, '');

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let hunk: DiffHunk | undefined;
  let oldNo = 0;
  let newNo = 0;

  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const m = raw.match(/^diff --git (?:"?a\/)?(.+?)"? (?:"?b\/)(.+?)"?$/);
      file = {
        path: m?.[2] ?? raw.slice(11),
        status: 'modified',
        additions: 0,
        deletions: 0,
        binary: false,
        hunks: [],
      };
      files.push(file);
      hunk = undefined;
      continue;
    }
    if (!file) continue;

    if (!hunk) {
      if (raw.startsWith('new file mode')) file.status = 'added';
      else if (raw.startsWith('deleted file mode')) file.status = 'deleted';
      else if (raw.startsWith('rename from ')) {
        file.status = 'renamed';
        file.oldPath = unquote(raw.slice(12));
      } else if (raw.startsWith('rename to ')) file.path = unquote(raw.slice(10));
      else if (raw.startsWith('+++ ') && raw !== '+++ /dev/null') file.path = strip(raw.slice(4));
      else if (raw === '--- /dev/null') file.status = 'added';
      else if (raw === '+++ /dev/null') file.status = 'deleted';
      else if (raw.startsWith('Binary files ')) file.binary = true;
    }

    const header = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      oldNo = Number(header[1]);
      newNo = Number(header[2]);
      hunk = { header: raw, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;

    const sign = raw[0];
    const body = raw.slice(1);
    if (sign === '+') {
      hunk.lines.push({ kind: 'add', text: body, newNo: newNo++ });
      file.additions++;
    } else if (sign === '-') {
      hunk.lines.push({ kind: 'del', text: body, oldNo: oldNo++ });
      file.deletions++;
    } else if (sign === ' ') {
      hunk.lines.push({ kind: 'ctx', text: body, oldNo: oldNo++, newNo: newNo++ });
    }
    // "\ No newline at end of file" and anything else is skipped.
  }
  return files;
}

export interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

/** Pairs a hunk's lines side by side: each run of deletions faces the additions after it. */
export function splitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as DiffLine;
    if (line.kind === 'ctx') {
      rows.push({ left: line, right: line });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (lines[i]?.kind === 'del') dels.push(lines[i++] as DiffLine);
    while (lines[i]?.kind === 'add') adds.push(lines[i++] as DiffLine);
    for (let j = 0; j < Math.max(dels.length, adds.length); j++) {
      rows.push({ left: dels[j] ?? null, right: adds[j] ?? null });
    }
  }
  return rows;
}

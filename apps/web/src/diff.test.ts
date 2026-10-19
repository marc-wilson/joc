import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDiff, splitRows } from './diff.ts';

const diff = `diff --git a/src/auth.ts b/src/auth.ts
index 1111111..2222222 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -10,4 +10,5 @@ export function login() {
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 return a;
diff --git a/README.md b/README.md
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/README.md
@@ -0,0 +1,2 @@
+# JOC
+Hello
\\ No newline at end of file
diff --git a/old.ts b/new.ts
similarity index 90%
rename from old.ts
rename to new.ts
diff --git a/logo.png b/logo.png
Binary files a/logo.png and b/logo.png differ
`;

test('files, statuses and counts', () => {
  const files = parseDiff(diff);
  assert.deepEqual(
    files.map((f) => [f.path, f.status, f.additions, f.deletions, f.binary]),
    [
      ['src/auth.ts', 'modified', 2, 1, false],
      ['README.md', 'added', 2, 0, false],
      ['new.ts', 'renamed', 0, 0, false],
      ['logo.png', 'modified', 0, 0, true],
    ],
  );
  assert.equal(files[2]?.oldPath, 'old.ts');
});

test('line numbers follow the hunk header', () => {
  const lines = parseDiff(diff)[0]?.hunks[0]?.lines ?? [];
  assert.deepEqual(
    lines.map((l) => [l.kind, l.oldNo, l.newNo]),
    [
      ['ctx', 10, 10],
      ['del', 11, undefined],
      ['add', undefined, 11],
      ['add', undefined, 12],
      ['ctx', 12, 13],
    ],
  );
});

test('split view pairs deletions with the additions after them', () => {
  const rows = splitRows(parseDiff(diff)[0]?.hunks[0]?.lines ?? []);
  assert.deepEqual(
    rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null]),
    [
      ['const a = 1;', 'const a = 1;'],
      ['const b = 2;', 'const b = 3;'],
      [null, 'const c = 4;'],
      ['return a;', 'return a;'],
    ],
  );
});

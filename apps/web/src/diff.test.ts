import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDiff, pullFile, splitRows } from './diff.ts';

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

test("a pull request's file keeps GitHub's counts and paths, its lines from the patch", () => {
  const file = pullFile({
    path: 'src/auth/redirect.ts',
    status: 'modified',
    additions: 2,
    deletions: 1,
    patch:
      '@@ -4,2 +4,3 @@ export function signIn() {\n const next = target();\n-redirect("/");\n+redirect(next);\n+log("signed in");',
  });
  assert.deepEqual(
    [file.path, file.additions, file.deletions, file.note],
    ['src/auth/redirect.ts', 2, 1, undefined],
  );
  assert.deepEqual(
    file.hunks[0]?.lines.map((l) => [l.kind, l.oldNo, l.newNo]),
    [
      ['ctx', 4, 4],
      ['del', 5, undefined],
      ['add', undefined, 5],
      ['add', undefined, 6],
    ],
  );
});

test("a pull request's file without a patch says why it shows no lines", () => {
  const renamed = pullFile({
    path: 'src/auth/session.ts',
    oldPath: 'src/session.ts',
    status: 'renamed',
    additions: 0,
    deletions: 0,
  });
  assert.deepEqual(
    [renamed.oldPath, renamed.note],
    ['src/session.ts', 'Renamed, with no changes inside'],
  );
  const big = pullFile({ path: 'data/seed.json', status: 'added', additions: 9000, deletions: 0 });
  assert.deepEqual(
    [big.additions, big.hunks, big.note],
    [9000, [], 'No diff to show: binary, or too large to show'],
  );
});

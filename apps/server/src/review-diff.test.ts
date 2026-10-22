import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_DIFF_BYTES } from '@joc/protocol';
import { toDiffFiles } from './review-diff.ts';

const file = (filename: string, status: string, patch?: string) => ({
  filename,
  status,
  additions: 1,
  deletions: 1,
  patch,
});

test("GitHub's files become the tab's: statuses mapped, a renamed file's old path kept", () => {
  const { files, truncated } = toDiffFiles([
    file('src/a.ts', 'modified', '@@ -1 +1 @@\n-a\n+b'),
    file('src/b.ts', 'removed'),
    { ...file('src/c.ts', 'renamed'), previous_filename: 'lib/c.ts' },
    { ...file('src/d.ts', 'copied'), previous_filename: 'src/a.ts' },
    file('src/e.ts', 'changed'),
  ]);
  assert.equal(truncated, false);
  assert.deepEqual(
    files.map((f) => [f.path, f.oldPath, f.status, f.patch]),
    [
      ['src/a.ts', undefined, 'modified', '@@ -1 +1 @@\n-a\n+b'],
      ['src/b.ts', undefined, 'deleted', undefined],
      ['src/c.ts', 'lib/c.ts', 'renamed', undefined],
      ['src/d.ts', undefined, 'added', undefined],
      ['src/e.ts', undefined, 'modified', undefined],
    ],
  );
});

test('patches past the byte limit are left out, the files still listed', () => {
  const half = `@@ -1 +1 @@\n+${'x'.repeat(MAX_DIFF_BYTES / 2)}`;
  const { files, truncated } = toDiffFiles([
    file('a.ts', 'modified', half),
    file('b.ts', 'modified', half),
    file('c.ts', 'modified', '@@ -1 +1 @@\n+small'),
  ]);
  assert.equal(truncated, true);
  assert.deepEqual(
    files.map((f) => [f.path, !!f.patch]),
    [
      ['a.ts', true],
      ['b.ts', false],
      ['c.ts', true],
    ],
  );
});

test('fewer files listed than the pull request changes is truncated', () => {
  assert.equal(toDiffFiles([file('a.ts', 'modified')], 4000).truncated, true);
  assert.equal(toDiffFiles([file('a.ts', 'modified')], 1).truncated, false);
});

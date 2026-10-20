// An installed plugin has no node_modules: its runtime code may import only `node:*` modules and
// its own files. Anything from @joc/* or another package must be `import type`, or every hook
// crashes on load.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const dir = new URL('./', import.meta.url);

test('plugin runtime code imports only node modules and its own files', () => {
  const sources = readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
  const found: string[] = [];
  for (const file of sources) {
    const text = readFileSync(new URL(file, dir), 'utf8');
    for (const [, kind, from] of text.matchAll(/^import\s+(type\s+)?[^;]*?from\s+'([^']+)'/gms)) {
      if (kind || from.startsWith('node:') || from.startsWith('.')) continue;
      found.push(`${file}: ${from}`);
    }
  }
  assert.deepEqual(found, []);
});

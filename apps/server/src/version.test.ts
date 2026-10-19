import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isBehind, readPluginVersion, webBuild } from './version.ts';

test('versions compare in semver order', () => {
  assert.equal(isBehind('0.2.0', '0.3.0'), true);
  assert.equal(isBehind('0.9.9', '0.10.0'), true);
  assert.equal(isBehind('1.0.0', '0.10.0'), false);
  assert.equal(isBehind('0.3.0', '0.3.0'), false);
  // A plugin ahead of the server (updated before a deploy) isn't behind.
  assert.equal(isBehind('0.4.0', '0.3.0'), false);
  assert.equal(isBehind('0.3.0-rc.1', '0.3.0'), true);
  assert.equal(isBehind('0.3.0', '0.3.0-rc.1'), false);
});

test("the server expects the repo's own plugin version", () => {
  assert.match(readPluginVersion(), /^\d+\.\d+\.\d+/);
});

test('the dashboard build is named by its index.html, and unset without one', () => {
  const dist = mkdtempSync(join(tmpdir(), 'joc-web-'));
  assert.equal(webBuild(undefined), undefined);
  assert.equal(webBuild(dist), undefined);
  writeFileSync(join(dist, 'index.html'), '<script src="/assets/index-a1.js"></script>');
  const first = webBuild(dist);
  assert.match(first ?? '', /^[0-9a-f]{12}$/);
  writeFileSync(join(dist, 'index.html'), '<script src="/assets/index-b2.js"></script>');
  assert.notEqual(webBuild(dist), first);
});

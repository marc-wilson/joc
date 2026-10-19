import assert from 'node:assert/strict';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { connection, readCredentials } from './credentials.ts';

const linked = { url: 'https://joc.example', token: 'machine-token' };

test('env overrides the link, which overrides local dev', () => {
  assert.deepEqual(connection({}, undefined), { url: 'http://localhost:3000', token: undefined });
  assert.deepEqual(connection({}, linked), { url: 'https://joc.example', token: 'machine-token' });
  assert.deepEqual(connection({ JOC_URL: 'http://localhost:3999/', JOC_TOKEN: 't' }, linked), {
    url: 'http://localhost:3999',
    token: 't',
  });
});

test('a link file is read, an empty or broken one counts as no link, and it ends up owner-only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'joc-credentials-'));
  const file = join(dir, 'credentials.json');
  assert.equal(readCredentials(file), undefined);
  writeFileSync(file, JSON.stringify(linked), { mode: 0o644 });
  assert.deepEqual(readCredentials(file), linked);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  writeFileSync(file, '{}\n');
  assert.equal(readCredentials(file), undefined);
  writeFileSync(file, 'not json');
  assert.equal(readCredentials(file), undefined);
});

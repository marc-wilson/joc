import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plain } from './plain.ts';
import { ago } from './time.ts';

test('markdown in a summary reads as plain text', () => {
  assert.equal(
    plain("You're all set. The workflow now reads the client ID from your **variable**:"),
    "You're all set. The workflow now reads the client ID from your variable:",
  );
  assert.equal(
    plain('## Run `pnpm test` in [atlas-web](https://x.example)'),
    'Run pnpm test in atlas-web',
  );
  assert.equal(plain('- an _important_ step'), 'an important step');
  assert.equal(plain('snake_case_name stays'), 'snake_case_name stays');
});

test('ago never says "now ago"', () => {
  const now = Date.parse('2026-10-18T10:00:00.000Z');
  assert.equal(ago('2026-10-18T10:00:00.000Z', now), 'just now');
  assert.equal(ago('2026-10-18T09:57:00.000Z', now), '3m ago');
});

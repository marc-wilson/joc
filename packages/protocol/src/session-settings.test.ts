import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionSettings, settleSessionSettings } from './index.ts';

test('the settings offer the keep times the design has, and nothing else', () => {
  assert.ok(SessionSettings.safeParse({ quiet: '3d', ended: 'now' }).success);
  assert.ok(SessionSettings.safeParse({ quiet: '30d', ended: '1w' }).success);
  assert.equal(SessionSettings.safeParse({ quiet: 'never', ended: '1d' }).success, false);
  assert.equal(SessionSettings.safeParse({ quiet: '1w', ended: '30d' }).success, false);
});

test('a stored keep time no longer offered moves to the nearest one', () => {
  assert.deepEqual(settleSessionSettings({ quiet: '1h', ended: '1h' }), {
    quiet: '1d',
    ended: 'now',
  });
  assert.deepEqual(settleSessionSettings({ quiet: 'never', ended: 'never' }), {
    quiet: '30d',
    ended: '1w',
  });
  assert.deepEqual(settleSessionSettings({ quiet: '1w', ended: '30d' }), {
    quiet: '1w',
    ended: '1w',
  });
  // Those still offered stay as they are.
  assert.deepEqual(settleSessionSettings({ quiet: '30d', ended: '1d' }), {
    quiet: '30d',
    ended: '1d',
  });
});

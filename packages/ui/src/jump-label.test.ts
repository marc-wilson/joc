import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jumpLabel } from './jump-label.ts';

test('the jump control names how many messages are new', () => {
  assert.equal(jumpLabel(0), 'Jump to latest');
  assert.equal(jumpLabel(1), '1 new message');
  assert.equal(jumpLabel(3), '3 new messages');
});

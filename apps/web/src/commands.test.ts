import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandLine } from './commands.ts';

test('a command reads as it was typed', () => {
  assert.equal(commandLine({ name: 'compact', args: '' }), '/compact');
  assert.equal(commandLine({ name: 'harbor:deploy', args: 'staging' }), '/harbor:deploy staging');
});

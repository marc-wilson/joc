import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mcpSummary } from './status.ts';

test('the MCP row counts connected and failing servers', () => {
  assert.equal(mcpSummary([]), 'None');
  assert.equal(
    mcpSummary([
      { name: 'linear', state: 'connected', tools: 12 },
      { name: 'harbor-docs', state: 'connected', tools: 3 },
      { name: 'atlas-db', state: 'failed' },
    ]),
    '2 connected · 1 failing',
  );
  assert.equal(mcpSummary([{ name: 'atlas-db', state: 'failed' }]), '1 failing');
  assert.equal(mcpSummary([{ name: 'linear', state: 'connected' }]), '1 connected');
});

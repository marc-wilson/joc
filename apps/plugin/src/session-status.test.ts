import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configuredServers, mcpServers, statusKey, statusReport } from './session-status.ts';

const root = '/Users/dana/dev/atlas-web';

test('the servers set up are the user’s, the project’s and its approved .mcp.json ones', () => {
  const claudeJson = {
    // Read for server names only; the rest of the file never leaves the machine.
    oauthAccount: { emailAddress: 'dana@harbor-labs.dev' },
    mcpServers: { 'harbor-docs': { command: 'harbor-docs' } },
    projects: {
      [root]: {
        mcpServers: { 'atlas-db': {} },
        enabledMcpjsonServers: ['linear'],
        disabledMcpServers: ['old-search'],
      },
      '/Users/dana/dev/other': { mcpServers: { elsewhere: {} } },
    },
  };
  const mcpJson = { mcpServers: { linear: {}, unapproved: {}, 'old-search': {} } };
  assert.deepEqual(configuredServers({ claudeJson, mcpJson, root }), [
    'harbor-docs',
    'atlas-db',
    'linear',
  ]);
  // Settings can approve all of .mcp.json, or turn one off.
  const settings = [{ enableAllProjectMcpServers: true }, { disabledMcpjsonServers: ['linear'] }];
  assert.deepEqual(configuredServers({ claudeJson, mcpJson, settings, root }), [
    'harbor-docs',
    'atlas-db',
    'unapproved',
  ]);
});

test('files that are missing or not what they should be set up nothing', () => {
  assert.deepEqual(configuredServers({ root }), []);
  assert.deepEqual(
    configuredServers({ claudeJson: 'nope', mcpJson: [1], settings: [null], root }),
    [],
  );
});

test('a server with tools is connected; one set up without any failed', () => {
  const tools = [
    { serverName: 'linear' },
    { serverName: 'harbor-docs' },
    { serverName: 'linear' },
    { serverName: 'claude.ai Gmail' },
  ];
  assert.deepEqual(mcpServers(tools, ['linear', 'atlas-db', 'harbor-docs']), [
    { name: 'claude.ai Gmail', state: 'connected', tools: 1 },
    { name: 'harbor-docs', state: 'connected', tools: 1 },
    { name: 'linear', state: 'connected', tools: 2 },
    { name: 'atlas-db', state: 'failed' },
  ]);
  assert.deepEqual(mcpServers([], []), []);
});

test('a report keeps to the bounds, and the same status twice is the same key', () => {
  const report = statusReport('7f3a2c1e', 1, {
    version: '2.1.300',
    model: 'claude-opus-5-5',
    cwd: root,
    mcp: [],
  });
  assert.deepEqual(report, {
    sessionId: '7f3a2c1e',
    at: 1,
    version: '2.1.300',
    model: 'claude-opus-5-5',
    cwd: root,
    mcp: [],
  });
  assert.equal(statusReport('s', 1, { cwd: `/${'a'.repeat(1000)}`, mcp: [] }).cwd, undefined);
  assert.equal(statusReport('s', 1, { version: '', mcp: [] }).version, undefined);
  assert.equal(statusKey(report), statusKey({ ...report, at: 2 }));
  assert.notEqual(statusKey(report), statusKey({ ...report, model: 'claude-sonnet-5' }));
});

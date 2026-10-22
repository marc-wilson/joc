import assert from 'node:assert/strict';
import { test } from 'node:test';
import { statusView } from './session-status.ts';

const session = {
  id: '7f3a2c1e-4b5d-4e6f-8a9b-0c1d2e3f4a5b',
  title: 'Cache the route table',
  cwd: '/Users/dana/dev/atlas-web',
  model: 'claude-opus-5-5',
  plugin: '0.15.0',
};

test('the view shows what the plugin reported, over what the session says', () => {
  const view = statusView(session, {
    version: '2.1.300',
    model: 'claude-sonnet-5',
    mcp: [{ name: 'linear', state: 'connected', tools: 12 }],
    updatedAt: '2026-10-21T10:00:00.000Z',
  });
  assert.deepEqual(
    [view.name, view.id, view.folder, view.model, view.version, view.mcp?.length],
    ['Cache the route table', session.id, session.cwd, 'claude-sonnet-5', '2.1.300', 1],
  );
});

test('with nothing reported it says why', () => {
  assert.equal(statusView(session, undefined).missing, 'Loading');
  const none = statusView(session, null);
  assert.deepEqual(
    [none.missing, none.version, none.mcp, none.model],
    ['Not reported yet', undefined, undefined, 'claude-opus-5-5'],
  );
  assert.match(String(statusView({ ...session, plugin: '0.14.3' }, null).missing), /joc-update/);
  assert.match(String(statusView({ ...session, plugin: undefined }, null).missing), /too old/);
});

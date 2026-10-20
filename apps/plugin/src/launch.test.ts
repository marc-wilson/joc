import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backgroundId, launchArgv, sessionIdFor } from './launch.ts';

test('a launch runs claude --bg, named and prompted only when asked', () => {
  assert.deepEqual(launchArgv({}, {}), ['claude', '--bg']);
  assert.deepEqual(
    launchArgv({ name: 'Review harbor-labs/atlas-web#7', prompt: '/code-review 7' }, {}),
    ['claude', '--bg', '--name', 'Review harbor-labs/atlas-web#7', '--', '/code-review 7'],
  );
  // A prompt that starts with a dash is still the prompt.
  assert.deepEqual(launchArgv({ prompt: '-v' }, {}).slice(-2), ['--', '-v']);
});

test('the new session reports where this one does, when the environment says where', () => {
  const argv = launchArgv({ prompt: 'hi' }, { url: 'http://localhost:3999' });
  assert.deepEqual(argv.slice(0, 4), [
    'claude',
    '--bg',
    '--settings',
    JSON.stringify({ env: { JOC_URL: 'http://localhost:3999' } }),
  ]);
});

test('the short id comes from what claude --bg prints', () => {
  const printed = [
    'Starting background service…',
    'backgrounded · 399073e7 · Review harbor-labs/atlas-web#7',
    '  claude agents             list sessions',
  ].join('\n');
  assert.equal(backgroundId(printed), '399073e7');
  assert.equal(backgroundId('backgrounded · 06f28f1a (idle — send a prompt to start)'), '06f28f1a');
  assert.equal(backgroundId('Workspace not trusted.'), undefined);
});

test('the full session id comes from claude agents', () => {
  const agents = JSON.stringify([
    { id: '0ba3e866', kind: 'background', sessionId: '0ba3e866-e476-41ba-8ed8-d2376fa82a0d' },
    { pid: 1, kind: 'interactive', sessionId: '6bd9be7a-8207-4c77-93d0-b959a1becfe8' },
    { id: '399073e7', kind: 'background', sessionId: '399073e7-821a-4dec-844b-0653ae6fd34b' },
  ]);
  assert.equal(sessionIdFor(agents, '399073e7'), '399073e7-821a-4dec-844b-0653ae6fd34b');
  assert.equal(sessionIdFor(agents, 'ffffffff'), undefined);
  assert.equal(sessionIdFor('not json', '399073e7'), undefined);
});

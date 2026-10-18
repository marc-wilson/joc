import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseGitHubRepo } from './git.ts';
import { describeTool, eventFields, firstLine, type HookInput } from './report.ts';

const base: HookInput = { session_id: 's1', hook_event_name: '', cwd: '/work/atlas-web' };
const event = (hook_event_name: string, extra: Partial<HookInput> = {}) =>
  eventFields({ ...base, hook_event_name, ...extra });

test('a prompt makes the session work and titles it from the first line', () => {
  assert.deepEqual(event('UserPromptSubmit', { prompt: '\n  Fix the   login loop\nmore' }), {
    state: 'working',
    activity: 'Thinking',
    title: 'Fix the login loop',
  });
});

test('a custom session title wins over the prompt', () => {
  assert.equal(event('UserPromptSubmit', { prompt: 'x', session_title: 'Auth' })?.title, 'Auth');
});

test('tool calls describe what they touch', () => {
  assert.equal(
    describeTool({
      ...base,
      tool_name: 'Edit',
      tool_input: { file_path: '/work/atlas-web/src/a.ts' },
    }),
    'Edit src/a.ts',
  );
  assert.equal(
    describeTool({ ...base, tool_name: 'Bash', tool_input: { command: 'pnpm test\necho done' } }),
    'pnpm test',
  );
  assert.equal(describeTool({ ...base, tool_name: 'TodoWrite' }), 'TodoWrite');
});

test('a permission request needs you', () => {
  assert.deepEqual(
    event('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } }),
    { state: 'needs', activity: 'Permission: rm -rf dist' },
  );
});

test('stop is idle, or background while tasks still run', () => {
  assert.equal(event('Stop', { last_assistant_message: 'All tests pass.' })?.state, 'idle');
  assert.equal(
    event('Stop', { last_assistant_message: 'All tests pass.' })?.activity,
    'All tests pass.',
  );
  assert.deepEqual(event('Stop', { background_tasks: [{}, {}] }), {
    state: 'background',
    activity: '2 background tasks running',
  });
});

test('session end is offline, and compaction changes nothing', () => {
  assert.equal(event('SessionEnd')?.state, 'offline');
  assert.equal(event('SessionStart', { source: 'compact' }), undefined);
  assert.equal(event('SubagentStop'), undefined);
});

test('firstLine trims and cuts long text', () => {
  assert.equal(firstLine('a'.repeat(10), 5), 'aaaa…');
  assert.equal(firstLine('  \n '), undefined);
});

test('GitHub remotes parse to owner/name', () => {
  assert.equal(
    parseGitHubRepo('git@github.com:harbor-labs/atlas-web.git'),
    'harbor-labs/atlas-web',
  );
  assert.equal(
    parseGitHubRepo('https://github.com/harbor-labs/atlas-web'),
    'harbor-labs/atlas-web',
  );
  assert.equal(parseGitHubRepo('https://gitlab.com/harbor-labs/atlas-web.git'), undefined);
});

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
    name: undefined,
  });
});

test('a custom session name is reported as the name', () => {
  assert.equal(event('UserPromptSubmit', { prompt: 'x', session_title: 'Auth' })?.name, 'Auth');
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

test('transcript lines become conversation items', async () => {
  const { parseLines } = await import('./transcript.ts');
  const t = '2026-10-18T10:00:00.000Z';
  const lines = [
    JSON.stringify({
      type: 'user',
      uuid: 'u1',
      timestamp: t,
      message: { content: 'Fix the login loop' },
    }),
    JSON.stringify({
      type: 'user',
      uuid: 'u2',
      timestamp: t,
      isMeta: true,
      message: { content: 'caveat' },
    }),
    JSON.stringify({
      type: 'user',
      uuid: 'u3',
      timestamp: t,
      message: { content: '<command-name>/review</command-name><command-args>auth</command-args>' },
    }),
    JSON.stringify({
      type: 'user',
      uuid: 'u4',
      timestamp: t,
      message: { content: '<local-command-stdout>x' },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      timestamp: t,
      message: { content: [{ type: 'thinking' }] },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'a2',
      timestamp: t,
      message: { content: [{ type: 'text', text: 'Reproduced it.' }] },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'a3',
      timestamp: t,
      message: {
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pnpm test' } }],
      },
    }),
    JSON.stringify({
      type: 'user',
      uuid: 'u5',
      timestamp: t,
      message: {
        content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'boom' }],
      },
    }),
    JSON.stringify({ type: 'ai-title', aiTitle: 'Login loop fix' }),
    'not json',
  ];
  const { items, aiTitle } = parseLines(lines, '/work');
  assert.equal(aiTitle, 'Login loop fix');
  assert.deepEqual(
    items.map((i) => [i.kind, 'text' in i ? i.text : 'summary' in i ? i.summary : '']),
    [
      ['user', 'Fix the login loop'],
      ['user', 'auth'],
      ['claude', 'Reproduced it.'],
      ['tool_call', 'pnpm test'],
      ['tool_result', 'boom'],
    ],
  );
  assert.equal(items[1]?.kind === 'user' && items[1].command, 'review');
});

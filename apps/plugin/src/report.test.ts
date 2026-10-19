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

test('background shells, subagents and their task notifications are recognized', async () => {
  const { parseLines } = await import('./transcript.ts');
  const t = '2026-10-18T10:00:00.000Z';
  const call = (uuid: string, id: string, name: string, input: Record<string, unknown>) =>
    JSON.stringify({
      type: 'assistant',
      uuid,
      timestamp: t,
      message: { content: [{ type: 'tool_use', id, name, input }] },
    });
  const result = (uuid: string, id: string, toolUseResult: unknown) =>
    JSON.stringify({
      type: 'user',
      uuid,
      timestamp: t,
      toolUseResult,
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'started' }] },
    });
  const notice = (status: string, toolUse = '') =>
    `<task-notification>\n<task-id>bg1</task-id>\n${toolUse}<status>${status}</status>\n<summary>Background command "Dev server" ${status}</summary>\n</task-notification>`;
  const lines = [
    call('a1', 't1', 'Bash', {
      command: 'pnpm dev',
      description: 'Dev server',
      run_in_background: true,
    }),
    result('u1', 't1', { stdout: '', backgroundTaskId: 'bg1' }),
    call('a2', 't2', 'Agent', { description: 'Map the auth flow', subagent_type: 'Explore' }),
    result('u2', 't2', { status: 'async_launched', agentId: 'ag1', isAsync: true }),
    call('a3', 't3', 'Task', { description: 'Review', run_in_background: 'true' }),
    call('a4', 't4', 'Bash', { command: 'ls' }),
    JSON.stringify({
      type: 'user',
      uuid: 'u3',
      timestamp: t,
      message: { content: notice('completed', '<tool-use-id>t1</tool-use-id>\n') },
    }),
    JSON.stringify({
      type: 'attachment',
      uuid: 'q1',
      timestamp: t,
      attachment: { type: 'queued_command', prompt: notice('killed') },
    }),
    JSON.stringify({
      type: 'user',
      uuid: 'u4',
      timestamp: t,
      message: { content: notice('running') },
    }),
  ];
  const items = parseLines(lines, '/work').items;
  const byId = new Map(items.map((i) => [i.id, i]));
  const toolCall = (id: string) => {
    const item = byId.get(id);
    return item?.kind === 'tool_call' ? item : undefined;
  };
  const toolResult = (id: string) => {
    const item = byId.get(id);
    return item?.kind === 'tool_result' ? item : undefined;
  };

  assert.equal(toolCall('a1:0')?.background, true);
  assert.equal(toolCall('a1:0')?.description, 'Dev server');
  assert.equal(toolCall('a1:0')?.subagent, undefined);
  assert.equal(toolCall('a2:0')?.subagent, 'Explore');
  assert.equal(toolCall('a2:0')?.background, undefined);
  assert.equal(toolCall('a3:0')?.subagent, 'general-purpose');
  assert.equal(toolCall('a3:0')?.background, true);
  assert.equal(toolCall('a4:0')?.background, undefined);

  assert.equal(toolResult('u1:0')?.taskId, 'bg1');
  assert.equal(toolResult('u2:0')?.taskId, 'ag1');

  assert.deepEqual(byId.get('u3'), {
    id: 'u3',
    at: t,
    kind: 'task_update',
    taskId: 'bg1',
    toolUseId: 't1',
    status: 'completed',
    summary: 'Background command "Dev server" completed',
  });
  const queued = byId.get('q1');
  assert.equal(queued?.kind === 'task_update' && queued.status, 'killed');
  assert.equal(queued?.kind === 'task_update' && queued.toolUseId, undefined);
  // Progress without a final status is not an update, and never a user message.
  assert.equal(byId.has('u4'), false);
});

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import {
  lastReported,
  type Reported,
  readTail,
  readTranscriptState,
  rememberReported,
  settledFields,
  type TranscriptState,
} from './settle.ts';

const shell = { id: 'bk3d9q2x1', type: 'shell' };
const agent = { id: 'a71c0e5f9b2d4e6a', type: 'subagent' };
const inBackground = (tasks?: Reported['tasks']): Reported => ({
  state: 'background',
  at: 1000,
  ...(tasks ? { tasks } : {}),
});
const transcriptOf = (ended: string[], lastReply?: string): TranscriptState => ({
  ended: new Set(ended),
  lastReply,
});

test('background work that all ended settles the session as idle with nothing running', () => {
  assert.deepEqual(
    settledFields(
      inBackground([shell, agent]),
      true,
      transcriptOf([shell.id, agent.id], 'The atlas-web build is green.'),
    ),
    { state: 'idle', activity: 'The atlas-web build is green.', background: [] },
  );
});

test('with no reply from Claude to show, the activity is Done', () => {
  assert.deepEqual(settledFields(inBackground([shell]), true, transcriptOf([shell.id])), {
    state: 'idle',
    activity: 'Done',
    background: [],
  });
});

test('a task Claude Code itself listed as ended counts as ended', () => {
  const killed = { ...shell, status: 'killed' };
  assert.equal(settledFields(inBackground([killed]), true, transcriptOf([]))?.state, 'idle');
});

test('a task still running keeps the state as it is', () => {
  const running = { ...agent, status: 'running' };
  assert.equal(
    settledFields(inBackground([shell, running]), true, transcriptOf([shell.id])),
    undefined,
  );
});

test('a scheduled wakeup the transcript cannot vouch for keeps the state', () => {
  const cron = { id: 'c-4f2a', type: 'cron' };
  assert.equal(settledFields(inBackground([cron]), true, transcriptOf([])), undefined);
});

test('an unknown list of tasks keeps the state', () => {
  assert.equal(settledFields(inBackground(), true, transcriptOf([shell.id])), undefined);
});

test('mid-turn, nothing changes', () => {
  assert.equal(settledFields(inBackground([shell]), false, transcriptOf([shell.id])), undefined);
});

test('only a background state is ever settled: working and needs stay', () => {
  for (const state of ['working', 'needs', 'idle', 'offline'] as const) {
    const reported: Reported = { state, at: 1000, tasks: [] };
    assert.equal(settledFields(reported, true, transcriptOf([])), undefined, state);
  }
  assert.equal(settledFields(undefined, true, transcriptOf([])), undefined);
  assert.equal(settledFields(inBackground([shell]), true, undefined), undefined);
});

// Transcript lines as Claude Code writes them, trimmed to what's read.
const user = (content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'user', uuid: 'u', message: { role: 'user', content }, ...extra });
const assistant = (content: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'assistant',
    uuid: 'a',
    message: { role: 'assistant', content },
    ...extra,
  });
const notification = (id: string, status: string) =>
  `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n<summary>Background command "pnpm test" ${status}</summary>\n</task-notification>`;

test('the transcript tells ended tasks: final notifications, queued or not, and stops', () => {
  const lines = [
    user(notification('bk3d9q2x1', 'completed')),
    JSON.stringify({
      type: 'attachment',
      attachment: { type: 'queued_command', prompt: notification('a71c0e5f9b2d4e6a', 'failed') },
    }),
    user([{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{}' }], {
      toolUseResult: {
        message: 'Successfully stopped task: bz8m1k4p0 (pnpm --filter atlas-web dev)',
        task_id: 'bz8m1k4p0',
        task_type: 'local_bash',
      },
    }),
    user([{ type: 'tool_result', tool_use_id: 'toolu_2', content: '{}' }], {
      toolUseResult: { message: 'Successfully killed shell: bq5n7r3t6', shell_id: 'bq5n7r3t6' },
    }),
  ];
  assert.deepEqual(
    [...readTranscriptState(lines).ended].sort(),
    ['a71c0e5f9b2d4e6a', 'bk3d9q2x1', 'bq5n7r3t6', 'bz8m1k4p0'].sort(),
  );
});

test('a progress notification, a failed stop and a subagent line end nothing', () => {
  const lines = [
    user(notification('bk3d9q2x1', 'running')),
    user([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'No task found' }], {
      toolUseResult: { message: 'No task found with ID: bz8m1k4p0', task_id: 'bz8m1k4p0' },
    }),
    user(notification('bq5n7r3t6', 'completed'), { isSidechain: true }),
    'not json',
  ];
  assert.equal(readTranscriptState(lines).ended.size, 0);
});

test("the activity is the first line of Claude's last reply in the main conversation", () => {
  const lines = [
    assistant([{ type: 'text', text: 'Starting the harbor-labs dev server.' }]),
    assistant([
      { type: 'thinking', thinking: '' },
      { type: 'text', text: '\nStopped the dev server.\nNothing else runs.' },
    ]),
    assistant([{ type: 'tool_use', id: 'toolu_3', name: 'Bash', input: {} }]),
    assistant([{ type: 'text', text: 'A subagent note' }], { isSidechain: true }),
  ];
  assert.equal(readTranscriptState(lines).lastReply, 'Stopped the dev server.');
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'joc-settle-test-'));
  process.env.CLAUDE_PLUGIN_DATA = dir;
});
afterEach(() => {
  delete process.env.CLAUDE_PLUGIN_DATA;
  rmSync(dir, { recursive: true, force: true });
});

test('what was reported is remembered per session, and an older report never overwrites it', () => {
  const session = 'settle-test-session';
  assert.equal(lastReported(session), undefined);
  rememberReported(
    session,
    {
      state: 'background',
      activity: '1 background task running',
      background: [{ ...shell, status: 'running', command: 'pnpm --filter atlas-web dev' }],
    },
    2000,
  );
  rememberReported(session, { state: 'working', activity: 'Thinking' }, 1500);
  assert.deepEqual(lastReported(session), {
    state: 'background',
    at: 2000,
    tasks: [{ ...shell, status: 'running' }],
  });
  rememberReported(session, { state: 'idle', activity: 'Done', background: [] }, 3000);
  assert.deepEqual(lastReported(session), { state: 'idle', at: 3000, tasks: [] });
  rememberReported(session, { state: 'working', activity: 'Thinking' }, 4000);
  assert.deepEqual(lastReported(session), { state: 'working', at: 4000 });
});

test('readTail keeps whole lines only, from the end', () => {
  const file = join(dir, 't.jsonl');
  writeFileSync(file, 'first line\nsecond line\nthird line\npartial');
  assert.deepEqual(readTail(file), ['first line', 'second line', 'third line']);
  assert.deepEqual(readTail(file, 18), ['third line']);
});

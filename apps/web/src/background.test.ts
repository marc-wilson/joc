import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConversationItem } from '@joc/protocol';
import {
  arrangeTasks,
  type BackgroundTask,
  backgroundTasks,
  elapsed,
  latestStep,
} from './background.ts';

const at = (s: number) => new Date(Date.UTC(2026, 9, 18, 10, 0, s)).toISOString();

const items: ConversationItem[] = [
  {
    id: 'c1',
    at: at(0),
    kind: 'tool_call',
    toolUseId: 't1',
    name: 'Bash',
    summary: 'pnpm dev',
    description: 'Dev server',
    background: true,
  },
  {
    id: 'r1',
    at: at(1),
    kind: 'tool_result',
    toolUseId: 't1',
    isError: false,
    text: '',
    taskId: 'bg1',
  },
  {
    id: 'c2',
    at: at(2),
    kind: 'tool_call',
    toolUseId: 't2',
    name: 'Agent',
    summary: 'Map auth',
    description: 'Map auth',
    subagent: 'Explore',
  },
  {
    id: 'r2',
    at: at(9),
    kind: 'tool_result',
    toolUseId: 't2',
    isError: false,
    text: '\nAuth lives in src/auth.ts\nmore',
  },
  {
    id: 'c3',
    at: at(3),
    kind: 'tool_call',
    toolUseId: 't3',
    name: 'Agent',
    summary: 'Review',
    subagent: 'general-purpose',
  },
  {
    id: 'r3',
    at: at(4),
    kind: 'tool_result',
    toolUseId: 't3',
    isError: false,
    text: 'started',
    taskId: 'ag1',
  },
  { id: 'c4', at: at(5), kind: 'tool_call', toolUseId: 't4', name: 'Bash', summary: 'pnpm test' },
  { id: 'r4', at: at(6), kind: 'tool_result', toolUseId: 't4', isError: false, text: 'ok' },
  {
    id: 'c5',
    at: at(7),
    kind: 'tool_call',
    toolUseId: 't5',
    name: 'Bash',
    summary: 'pnpm build',
    background: true,
  },
  {
    id: 'r5',
    at: at(8),
    kind: 'tool_result',
    toolUseId: 't5',
    isError: false,
    text: '',
    taskId: 'bg2',
  },
  {
    id: 'c6',
    at: at(8),
    kind: 'tool_call',
    toolUseId: 't6',
    name: 'Agent',
    summary: 'Plan',
    subagent: 'Plan',
  },
  {
    id: 'u1',
    at: at(20),
    kind: 'task_update',
    taskId: 'bg2',
    toolUseId: 't5',
    status: 'failed',
    summary: 'Exit code 1',
  },
  { id: 'u2', at: at(30), kind: 'task_update', taskId: 'ag1', status: 'killed', summary: '' },
];

test('background work is listed in start order with what is known about it', () => {
  const tasks = backgroundTasks(items, 'background');
  assert.deepEqual(
    tasks.map((t) => [t.id, t.kind, t.label, t.title, t.command, t.status, t.tail]),
    [
      ['t1', 'shell', undefined, 'Dev server', 'pnpm dev', 'running', undefined],
      ['t2', 'subagent', 'Explore', 'Map auth', undefined, 'pass', 'Auth lives in src/auth.ts'],
      ['t3', 'subagent', 'general-purpose', 'Review', undefined, 'ended', 'Stopped'],
      ['t5', 'shell', undefined, 'Background command', 'pnpm build', 'fail', 'Exit code 1'],
      ['t6', 'subagent', 'Plan', 'Plan', undefined, 'running', undefined],
    ],
  );
  assert.equal(tasks[2]?.endedAt, at(30));
});

test('nothing runs on in an ended session', () => {
  const tasks = backgroundTasks(items, 'offline');
  assert.equal(tasks.filter((t) => t.status === 'running').length, 0);
  assert.equal(tasks[0]?.tail, 'The session ended');
});

test('a background call that never started a task is not shown as running', () => {
  const [task] = backgroundTasks(
    [
      {
        id: 'c',
        at: at(0),
        kind: 'tool_call',
        toolUseId: 't',
        name: 'Bash',
        summary: 'x',
        background: true,
      },
      { id: 'r', at: at(1), kind: 'tool_result', toolUseId: 't', isError: true, text: 'Denied' },
    ],
    'idle',
  );
  assert.equal(task?.status, 'fail');
});

test('elapsed time reads compactly', () => {
  assert.equal(elapsed(at(0), at(8)), '8s');
  assert.equal(elapsed(at(0), Date.parse(at(0)) + 252_000), '4m 12s');
  assert.equal(elapsed(at(0), Date.parse(at(0)) + 7_500_000), '2h 5m');
});

test('a task keeps what it was asked and how it ended, for its details', () => {
  const tasks = backgroundTasks(
    [
      {
        id: 'c1',
        at: at(0),
        kind: 'tool_call',
        toolUseId: 't1',
        name: 'Agent',
        summary: 'Map auth',
        subagent: 'Explore',
        background: true,
        prompt: 'Find where harbor-labs/atlas-web signs people in.',
      },
      {
        id: 'r1',
        at: at(1),
        kind: 'tool_result',
        toolUseId: 't1',
        isError: false,
        text: 'started',
        taskId: 'ag1',
      },
      {
        id: 'u1',
        at: at(9),
        kind: 'task_update',
        taskId: 'ag1',
        status: 'completed',
        summary: 'Agent "Map auth" finished',
        result: 'Sign-in starts in src/auth.ts.',
      },
      {
        id: 'c2',
        at: at(2),
        kind: 'tool_call',
        toolUseId: 't2',
        name: 'Bash',
        summary: 'pnpm build &&',
        command: 'pnpm build &&\npnpm test',
        background: true,
      },
      {
        id: 'u2',
        at: at(8),
        kind: 'task_update',
        taskId: 'bg1',
        toolUseId: 't2',
        status: 'failed',
        summary: 'Exit code 1',
        output: '1 test failed',
      },
    ],
    'idle',
  );
  assert.deepEqual(
    tasks.map((t) => [t.prompt, t.report, t.fullCommand, t.output]),
    [
      [
        'Find where harbor-labs/atlas-web signs people in.',
        'Sign-in starts in src/auth.ts.',
        undefined,
        undefined,
      ],
      [undefined, undefined, 'pnpm build &&\npnpm test', '1 test failed'],
    ],
  );
});

const task = (
  id: string,
  status: BackgroundTask['status'],
  start: number,
  end?: number,
): BackgroundTask => ({
  id,
  kind: 'subagent',
  title: id,
  status,
  startedAt: at(start),
  ...(end == null ? {} : { endedAt: at(end) }),
});

const ids = (tasks: BackgroundTask[]) => tasks.map((t) => t.id);

test('running tasks come first in start order, then finished ones newest first', () => {
  const { running, finished } = arrangeTasks([
    task('a', 'pass', 0, 5),
    task('b', 'running', 1),
    task('c', 'fail', 2, 9),
    task('d', 'running', 3),
    task('e', 'ended', 4),
  ]);
  assert.deepEqual(ids(running), ['b', 'd']);
  assert.deepEqual(ids(finished), ['c', 'a', 'e']);
});

test('a held task stays with the running ones after it ends', () => {
  const tasks = [task('a', 'pass', 0, 5), task('b', 'running', 1), task('c', 'pass', 2, 3)];
  const { running, finished } = arrangeTasks(tasks, ['c']);
  assert.deepEqual(ids(running), ['b', 'c']);
  assert.deepEqual(ids(finished), ['a']);
});

test('a subagent is doing what its latest step says', () => {
  const step = (i: number, item: Partial<ConversationItem>) =>
    ({ id: `s${i}`, at: at(i), task: 't2', ...item }) as ConversationItem;
  assert.equal(latestStep([]), undefined);
  assert.equal(
    latestStep([
      step(0, { kind: 'claude', text: 'Looking at **auth** first.' }),
      step(1, { kind: 'tool_call', toolUseId: 'x', name: 'Read', summary: 'src/auth.ts' }),
      step(2, { kind: 'tool_result', toolUseId: 'x', isError: false, text: 'export const a = 1' }),
    ]),
    'Read src/auth.ts',
  );
  assert.equal(
    latestStep([step(0, { kind: 'claude', text: '\nSign-in starts in `src/auth.ts`.\nMore' })]),
    'Sign-in starts in src/auth.ts.',
  );
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConversationItem, RunningTask } from '@joc/protocol';
import {
  arrangeTasks,
  type BackgroundTask,
  backgroundTasks,
  clock,
  elapsed,
  latestStep,
  lineCount,
  runningCount,
  runningLine,
  taskRowText,
  taskSteps,
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

test('a running time reads as a clock that keeps its width', () => {
  assert.equal(clock(at(0), at(8)), '0:08');
  assert.equal(clock(at(0), Date.parse(at(0)) + 252_000), '4:12');
  assert.equal(clock(at(0), Date.parse(at(0)) + 3_723_000), '1:02:03');
});

test("a subagent's steps are its tool calls, timed from its start, the last one current", () => {
  const steps: ConversationItem[] = [
    { id: 's1', at: at(2), kind: 'tool_call', toolUseId: 'u1', name: 'Glob', summary: '**/*.ts' },
    { id: 's2', at: at(3), kind: 'tool_result', toolUseId: 'u1', isError: false, text: '18' },
    { id: 's3', at: at(9), kind: 'claude', text: 'Reading them now.' },
    { id: 's4', at: at(50), kind: 'tool_call', toolUseId: 'u2', name: 'Read', summary: 'a.ts' },
  ];
  assert.deepEqual(taskSteps(steps, at(0), true), [
    { id: 's1', tool: 'Glob', target: '**/*.ts', time: '0:02', status: 'done' },
    { id: 's4', tool: 'Read', target: 'a.ts', time: '0:50', status: 'current' },
  ]);
  assert.equal(taskSteps(steps, at(0), false)[1]?.status, 'done');
});

test('a task stopped with TaskStop has ended, though Claude Code sent no notification', () => {
  const stop = (toolUseId: string, text: string): ConversationItem => ({
    id: `r-${toolUseId}`,
    at: at(40),
    kind: 'tool_result',
    toolUseId,
    isError: false,
    text,
  });
  const tasks = backgroundTasks(
    [
      ...items,
      stop('s1', '{"message":"Successfully stopped task: bg1 (pnpm dev)","task_id":"bg1"}'),
      stop('s2', 'No task found with ID: bg9'),
    ],
    'background',
  );
  const dev = tasks.find((t) => t.id === 't1');
  assert.deepEqual([dev?.status, dev?.tail, dev?.endedAt], ['ended', 'Stopped', at(40)]);
});

// Claude Code's own list of what runs, as the session's latest Stop reported it.
const listed = (s: number, tasks: RunningTask[]) => ({ at: at(s), tasks });

test("a transcript task runs while claude code's list has it, and has ended once it doesn't", () => {
  const tasks = backgroundTasks(items, 'background', listed(50, [{ id: 'bg1', type: 'shell' }]));
  const task = (id: string) => tasks.find((t) => t.id === id);
  assert.equal(task('t1')?.status, 'running');
  // t6 started before the list, which leaves it out: it ended, how isn't known.
  assert.deepEqual([task('t6')?.status, task('t6')?.tail], ['ended', 'Ended']);
  assert.equal(runningCount(tasks), 1);

  // The list says nothing runs: a task the transcript never saw end has ended too.
  const none = backgroundTasks(items, 'idle', listed(50, []));
  const dev = none.find((t) => t.id === 't1');
  assert.equal(runningCount(none), 0);
  assert.deepEqual([dev?.status, dev?.tail], ['ended', 'Ended']);
});

test('a task started after the latest list runs until a newer list says otherwise', () => {
  const tasks = backgroundTasks(items, 'working', listed(0, []));
  assert.equal(tasks.find((t) => t.id === 't1')?.status, 'running');
});

test("the transcript's end for a task beats a list that still has it", () => {
  const tasks = backgroundTasks(
    items,
    'background',
    listed(50, [
      { id: 'bg2', type: 'shell', command: 'pnpm build' },
      { id: 'ag1', type: 'subagent' },
    ]),
  );
  assert.equal(tasks.find((t) => t.id === 't5')?.status, 'fail');
  assert.equal(tasks.find((t) => t.id === 't3')?.status, 'ended');
  // Matched by Claude Code's id, so neither shows twice.
  assert.equal(tasks.length, 5);
});

test("work only claude code's list knows of shows as running, with its type", () => {
  const tasks = backgroundTasks(
    items,
    'background',
    listed(50, [
      { id: 'bg1', type: 'shell' },
      { id: 'tm1', type: 'teammate', description: 'Write the release notes\nfor 2.4' },
      { id: 'mo1', type: 'monitor', server: 'harbor-ci', tool: 'watch_build' },
      { id: 'wf1', type: 'workflow', name: 'nightly-triage' },
      { id: 'cr1', type: 'cron', description: 'check the deploy', schedule: '*/5 * * * *' },
      { id: 'sh9', type: 'shell', command: 'tail -f logs/atlas.log' },
    ]),
  );
  assert.deepEqual(
    tasks.slice(5).map((t) => [t.id, t.kind, t.label, t.title, t.command, t.status, t.startedAt]),
    [
      ['tm1', 'subagent', 'Teammate', 'Write the release notes', undefined, 'running', undefined],
      ['mo1', 'shell', 'Monitor', 'harbor-ci · watch_build', undefined, 'running', undefined],
      ['wf1', 'subagent', 'Workflow', 'nightly-triage', undefined, 'running', undefined],
      ['cr1', 'shell', 'Scheduled', 'check the deploy', '*/5 * * * *', 'running', undefined],
      [
        'sh9',
        'shell',
        undefined,
        'Background command',
        'tail -f logs/atlas.log',
        'running',
        undefined,
      ],
    ],
  );
  assert.equal(runningCount(tasks), 6);
  assert.equal(arrangeTasks(tasks).running.length, 6);
  assert.equal(runningLine(6), '6 background tasks running');
  assert.equal(runningLine(1), '1 background task running');
});

test('listed work has ended with its session', () => {
  const tasks = backgroundTasks([], 'offline', listed(50, [{ id: 'mo1', type: 'monitor' }]));
  assert.deepEqual(
    tasks.map((t) => [t.status, t.tail]),
    [['ended', 'The session ended']],
  );
  assert.equal(arrangeTasks(tasks).finished.length, 1);
});

test('a shell row is titled by its command, with the output Claude last read as it runs', () => {
  const read = (id: string, s: number, text: string): ConversationItem[] => [
    {
      id: `c-${id}`,
      at: at(s),
      kind: 'tool_call',
      toolUseId: id,
      name: 'TaskOutput',
      summary: 'bg1',
    },
    { id: `r-${id}`, at: at(s), kind: 'tool_result', toolUseId: id, isError: false, text },
  ];
  const shell = (extra: ConversationItem[]) =>
    backgroundTasks([...items.slice(0, 2), ...extra], 'working')[0] as BackgroundTask;

  // Before Claude read any of it: what it's for.
  assert.deepEqual(taskRowText(shell([])), { title: 'pnpm dev', line: 'Dev server' });
  // Then the last line it read, its tags left out; the newest read wins.
  const running = shell([
    ...read('o1', 4, 'Starting'),
    ...read('o2', 6, '<status>running</status>\n<output>\n  ready on :5173\n</output>'),
  ]);
  assert.deepEqual(taskRowText(running), { title: 'pnpm dev', line: 'ready on :5173' });

  // Once it ended, how it ended.
  const done = shell([
    {
      id: 'u1',
      at: at(8),
      kind: 'task_update',
      taskId: 'bg1',
      status: 'failed',
      summary: 'exit 1',
      output: 'a\nb\nc\n',
    },
  ]);
  assert.deepEqual(taskRowText(done), { title: 'pnpm dev', line: 'exit 1' });
  assert.equal(lineCount(done.output ?? ''), 3);
});

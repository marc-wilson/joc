import assert from 'node:assert/strict';
import { test } from 'node:test';
import { arrangeTeam, type ConversationItem, teammateTitle, teamOf } from './index.ts';

const at = (m: number) => new Date(Date.UTC(2026, 9, 20, 10, m)).toISOString();

const agent = (
  id: string,
  m: number,
  description: string,
  background = true,
): ConversationItem => ({
  id: `c-${id}`,
  at: at(m),
  kind: 'tool_call',
  toolUseId: id,
  name: 'Agent',
  summary: description,
  description,
  subagent: 'general-purpose',
  prompt: `Fix it. ${description}`,
  ...(background ? { background: true } : {}),
});

const launched = (id: string, agentId: string, m: number): ConversationItem => ({
  id: `r-${id}`,
  at: at(m),
  kind: 'tool_result',
  toolUseId: id,
  isError: false,
  text: 'Async agent launched successfully.',
  taskId: agentId,
});

const live = { state: 'working' as const };

test('a title names its issue, and loses a trailing number', () => {
  assert.deepEqual(teammateTitle('Reconnect to GitHub App #81'), {
    title: 'Reconnect to GitHub App',
    issue: 81,
  });
  assert.deepEqual(teammateTitle('Fix issue #2: plugin failures'), {
    title: 'Fix issue #2: plugin failures',
    issue: 2,
  });
  assert.deepEqual(teammateTitle('Audit resolvers'), { title: 'Audit resolvers' });
});

test('a background teammate works until its notification, then is done', () => {
  const items = [agent('t1', 0, 'Reconnect to GitHub App #81'), launched('t1', 'a81', 0)];
  const [working] = teamOf(items, live);
  assert.equal(working?.status, 'working');
  assert.equal(working?.agentId, 'a81');
  assert.equal(working?.issue, 81);
  const done = teamOf(
    [
      ...items,
      {
        id: 'n1',
        at: at(18),
        kind: 'task_update',
        taskId: 'a81',
        status: 'completed',
        summary: 'Agent completed',
        result: 'Fixed #81',
      },
    ],
    live,
  );
  assert.equal(done[0]?.status, 'done');
  assert.equal(done[0]?.endedAt, at(18));
});

test('a failed, a killed and a stopped teammate end that way', () => {
  const items: ConversationItem[] = [
    agent('t1', 0, 'Rail peek flickers #72', false),
    {
      id: 'r1',
      at: at(4),
      kind: 'tool_result',
      toolUseId: 't1',
      isError: true,
      text: 'boom\nmore',
    },
    agent('t2', 1, 'Rename props #70'),
    launched('t2', 'a70', 1),
    {
      id: 'r3',
      at: at(5),
      kind: 'tool_result',
      toolUseId: 'stop',
      isError: false,
      text: 'Successfully stopped task: a70',
    },
  ];
  const [failed, stopped] = teamOf(items, live);
  assert.equal(failed?.status, 'failed');
  assert.equal(failed?.tail, 'boom');
  assert.equal(stopped?.status, 'stopped');
});

test('a teammate that asks the session waits on it until the session answers', () => {
  const items: ConversationItem[] = [
    agent('t1', 0, 'Wrap long lines #84'),
    launched('t1', 'a84', 0),
    { id: 'm1', at: at(3), kind: 'agent_message', from: 'a84', text: 'Keep the toggle per file?' },
  ];
  const [waiting] = teamOf(items, live);
  assert.equal(waiting?.status, 'waiting');
  assert.equal(waiting?.tail, 'Keep the toggle per file?');
  const reply: ConversationItem = {
    id: 'c2',
    at: at(4),
    kind: 'tool_call',
    toolUseId: 's1',
    name: 'SendMessage',
    summary: 'a84',
    to: 'a84',
    message: 'Per file.',
  };
  assert.equal(teamOf([...items, reply], live)[0]?.status, 'working');
});

test('a teammate whose permission request waits on you needs you', () => {
  const items = [agent('t1', 0, 'Wrap long lines #84'), launched('t1', 'a84', 0)];
  const [needs] = teamOf(items, {
    state: 'needs',
    waiting: {
      kind: 'permission',
      id: 'wait-0001',
      tool: 'Bash',
      summary: 'pnpm e2e',
      agent: 'a84',
    },
  });
  assert.equal(needs?.status, 'needs');
  assert.equal(needs?.tail, 'Allow pnpm e2e?');
});

test('a message to a finished teammate resumes it', () => {
  const items: ConversationItem[] = [
    agent('t1', 0, 'Toast motion #79'),
    launched('t1', 'a79', 0),
    { id: 'n', at: at(5), kind: 'task_update', taskId: 'a79', status: 'completed', summary: '' },
    {
      id: 's',
      at: at(6),
      kind: 'tool_call',
      toolUseId: 's1',
      name: 'SendMessage',
      summary: 'a79',
      to: 'a79',
      message: 'Attach screenshots.',
    },
  ];
  const [t] = teamOf(items, live);
  assert.equal(t?.status, 'working');
  assert.equal(t?.endedAt, undefined);
});

test("Claude Code's list ends a teammate it no longer has, and adds ones only it knows", () => {
  const items = [agent('t1', 0, 'Toast motion #79'), launched('t1', 'a79', 0)];
  const team = teamOf(items, {
    state: 'idle',
    background: {
      at: at(10),
      tasks: [{ id: 'axx', type: 'subagent', description: 'Audit resolvers' }],
    },
  });
  assert.deepEqual(
    team.map((t) => [t.title, t.status]),
    [
      ['Toast motion', 'stopped'],
      ['Audit resolvers', 'working'],
    ],
  );
});

test('an ended session stops its live teammates', () => {
  const items = [agent('t1', 0, 'Toast motion #79'), launched('t1', 'a79', 0)];
  assert.equal(teamOf(items, { state: 'offline' })[0]?.status, 'stopped');
});

test('folders give teammates their branch and worktree; subagent steps are not teammates', () => {
  const items: ConversationItem[] = [
    agent('t1', 0, 'Toast motion #79'),
    { ...agent('t9', 1, 'Nested'), task: 't1' },
  ];
  const team = teamOf(items, {
    ...live,
    folders: [{ task: 't1', branch: 'fix/79-toast', worktree: '.claude/worktrees/79' }],
  });
  assert.equal(team.length, 1);
  assert.equal(team[0]?.branch, 'fix/79-toast');
  assert.equal(team[0]?.worktree, '.claude/worktrees/79');
});

test('the team arranges active then finished, newest first in each', () => {
  const { active, finished } = arrangeTeam([
    { id: 'a', status: 'done', startedAt: at(1) },
    { id: 'b', status: 'working', startedAt: at(2) },
    { id: 'c', status: 'waiting', startedAt: at(3) },
    { id: 'd', status: 'failed', startedAt: at(4) },
  ] as const);
  assert.deepEqual(
    active.map((t) => t.id),
    ['c', 'b'],
  );
  assert.deepEqual(
    finished.map((t) => t.id),
    ['d', 'a'],
  );
});

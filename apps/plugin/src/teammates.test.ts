import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentMessage, parseLines, subagentFolder } from './transcript.ts';
import { waitingFor } from './waiting.ts';

test("a teammate's permission request names the teammate", () => {
  const waiting = waitingFor('wait-0001', 'Bash', { command: 'pnpm e2e' }, '/work', 'a84');
  assert.equal(waiting?.agent, 'a84');
  assert.equal(waitingFor('wait-0001', 'Bash', { command: 'ls' }, '/work')?.agent, undefined);
});

// Teammates as Claude Code records them. Made-up fixtures in the transcript's own shapes.

const at = '2026-10-20T10:00:00.000Z';

const attach = (uuid: string, prompt: string) =>
  JSON.stringify({
    type: 'attachment',
    uuid,
    timestamp: at,
    attachment: { type: 'queued_command', prompt },
  });

const assistant = (uuid: string, content: unknown[]) =>
  JSON.stringify({ type: 'assistant', uuid, timestamp: at, message: { content } });

test('a teammate message becomes an agent_message; its hand-back is left to the notification', () => {
  const { items } = parseLines(
    [
      attach('m1', '<agent-message from="a84">\nKeep the wrap toggle per file?\n</agent-message>'),
      attach(
        'm2',
        '<agent-message from="a84">\n[Subagent hand-back] The report follows:\n  Done.\n</agent-message>',
      ),
    ],
    '/work',
  );
  assert.deepEqual(items, [
    { id: 'm1', at, kind: 'agent_message', from: 'a84', text: 'Keep the wrap toggle per file?' },
  ]);
  assert.equal(agentMessage('<task-notification></task-notification>'), undefined);
});

test('a SendMessage call names who it writes to and what it says', () => {
  const { items } = parseLines(
    [
      assistant('s1', [
        {
          type: 'tool_use',
          id: 'toolu_9',
          name: 'SendMessage',
          input: { to: 'a84', summary: 'Answer', message: 'Per file.' },
        },
      ]),
    ],
    '/work',
  );
  const [call] = items;
  assert.equal(call?.kind, 'tool_call');
  assert.equal(call?.kind === 'tool_call' && call.to, 'a84');
  assert.equal(call?.kind === 'tool_call' && call.message, 'Per file.');
});

test("a teammate's folder is its worktree, and its branch the latest one its steps saw", () => {
  const entry = (cwd: string, branch: string) => JSON.stringify({ cwd, gitBranch: branch });
  const tree = '/work/.claude/worktrees/agent-a79';
  const lines = [entry(tree, 'main'), entry(tree, 'fix/79-toast')];
  assert.deepEqual(subagentFolder('t1', { worktreePath: tree }, lines, '/work'), {
    task: 't1',
    branch: 'fix/79-toast',
    worktree: '.claude/worktrees/agent-a79',
  });
  // Outside the session's folder: its name alone. In the session's own folder: no worktree.
  const outside = subagentFolder('t1', { worktreePath: '/elsewhere/wt-79' }, [], '/work');
  assert.equal(outside.worktree, 'wt-79');
  assert.deepEqual(subagentFolder('t1', {}, [entry('/work', 'main')], '/work'), {
    task: 't1',
    branch: 'main',
  });
});

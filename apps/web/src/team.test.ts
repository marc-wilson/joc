import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConversationItem, Session, Teammate } from '@joc/protocol';
import { backgroundTasks, withoutTeammates } from './background.ts';
import {
  reportImages,
  reportParts,
  sessionTeam,
  shortElapsed,
  teamCounts,
  teamLine,
  teammateLine,
  teammateMessages,
  teammatePr,
  teammateReport,
  teammateSteps,
} from './team.ts';

const at = (m: number) => new Date(Date.UTC(2026, 9, 20, 10, m)).toISOString();

const items: ConversationItem[] = [
  {
    id: 'c1',
    at: at(0),
    kind: 'tool_call',
    toolUseId: 't1',
    name: 'Agent',
    summary: 'Toast motion',
    description: 'Toast stack ignores reduced motion #79',
    subagent: 'general-purpose',
    prompt: 'Fix #79.',
    background: true,
  },
  {
    id: 'r1',
    at: at(0),
    kind: 'tool_result',
    toolUseId: 't1',
    isError: false,
    text: 'Async agent launched successfully.',
    taskId: 'a79',
  },
  { id: 'm1', at: at(2), kind: 'agent_message', from: 'a79', text: 'Move it to the class?' },
  {
    id: 's1',
    at: at(3),
    kind: 'tool_call',
    toolUseId: 'x1',
    name: 'SendMessage',
    summary: 'a79',
    to: 'a79',
    message: 'Move it to the class.',
  },
  {
    id: 'n1',
    at: at(18),
    kind: 'task_update',
    taskId: 'a79',
    status: 'completed',
    summary: 'Agent completed',
    result: 'Fixed #79, draft PR #486 is open\n\nToasts now respect reduced motion.',
  },
  {
    id: 'b1',
    at: at(1),
    kind: 'tool_call',
    toolUseId: 'sh1',
    name: 'Bash',
    summary: 'pnpm dev',
    background: true,
  },
];

const session = {
  id: 's',
  repo: 'harbor-labs/atlas-web',
  state: 'idle',
  startedAt: at(0),
  updatedAt: at(20),
  team: [
    {
      id: 't1',
      title: 'Toast stack ignores reduced motion',
      status: 'done',
      branch: 'fix/79-toast',
    },
  ],
} satisfies Session;

test("the selected session's team comes from its conversation, with the server's folders", () => {
  const [mate] = sessionTeam(session, items);
  assert.equal(mate?.status, 'done');
  assert.equal(mate?.issue, 79);
  assert.equal(mate?.branch, 'fix/79-toast');
  // Before the conversation loads: what the server said.
  assert.equal(sessionTeam(session, [])[0]?.title, 'Toast stack ignores reduced motion');
});

test('teammates leave the Background tab, which keeps shells', () => {
  const tasks = withoutTeammates(backgroundTasks(items, 'idle'));
  assert.deepEqual(
    tasks.map((t) => t.id),
    ['sh1'],
  );
});

test('a teammate has its messages, its report and its pull request', () => {
  const [mate] = sessionTeam(session, items) as [Teammate];
  assert.deepEqual(
    teammateMessages(items, mate).map((m) => [m.from, m.text]),
    [
      ['mate', 'Move it to the class?'],
      ['lead', 'Move it to the class.'],
    ],
  );
  const report = teammateReport(items, mate);
  assert.equal(report?.at, at(18));
  assert.deepEqual(reportParts(report?.text ?? ''), {
    headline: 'Fixed #79, draft PR #486 is open',
    rest: 'Toasts now respect reduced motion.',
  });
  const pr = { number: 486, branch: 'fix/79-toast', repo: 'harbor-labs/atlas-web' };
  assert.equal(teammatePr(mate, [pr] as never, 'harbor-labs/atlas-web')?.number, 486);
  assert.equal(teammatePr({ ...mate, branch: undefined }, [pr] as never, 'x'), undefined);
});

test('counts, lines and times for the session list', () => {
  const team = [
    { id: 'a', title: 'A', status: 'working' },
    { id: 'b', title: 'B', status: 'waiting', tail: 'Per file?' },
    { id: 'c', title: 'C', status: 'failed', tail: 'pnpm e2e exited 1' },
  ] satisfies Teammate[];
  assert.deepEqual(teamCounts(team), { active: 2, total: 3, failed: 1 });
  assert.equal(teamLine(team), 'Waiting on 2 teammates');
  assert.equal(teamLine([]), undefined);
  assert.equal(teammateLine(team[1], []), 'Asked: Per file?');
  assert.equal(teammateLine(team[2], []), 'pnpm e2e exited 1');
  assert.equal(shortElapsed(at(0), at(12)), '12m');
  assert.equal(shortElapsed(at(0), at(125)), '2h 5m');
});

test('a teammate shows its last seven steps and counts the earlier ones', () => {
  const steps: ConversationItem[] = Array.from({ length: 10 }, (_, i) => ({
    id: `s${i}`,
    at: at(i),
    kind: 'tool_call',
    toolUseId: `u${i}`,
    name: 'Edit',
    summary: `src/file-${i}.ts`,
    task: 't1',
  }));
  const shown = teammateSteps(steps, at(0), true);
  assert.equal(shown.total, 10);
  assert.equal(shown.earlier, 3);
  assert.equal(shown.steps.length, 7);
  assert.equal(shown.steps.at(-1)?.status, 'current');
  assert.equal(shown.steps.at(-1)?.text, 'Edit src/file-9.ts');
});

test('only JOC images in a report are screenshots', () => {
  const id = 'a'.repeat(64);
  assert.deepEqual(reportImages(`See /api/images/${id} and https://example.test/x.png`), [id]);
  assert.deepEqual(reportImages(undefined), []);
});

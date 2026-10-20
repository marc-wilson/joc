import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import {
  lastOwnCwd,
  movesFolder,
  rememberedFolder,
  rememberFolder,
  sessionFolder,
} from './folder.ts';
import { parseTop, placeOf } from './git.ts';
import type { HookInput } from './report.ts';

// A made-up repo with its main checkout on `main` and a linked worktree on its own branch.
let root: string;
let main: string;
let worktree: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'joc-folder-')));
  main = join(root, 'atlas-web');
  worktree = join(main, '.claude', 'worktrees', 'agent-a71c0e5f');
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'remote', 'add', 'origin', 'git@github.com:harbor-labs/atlas-web.git');
  git(
    main,
    '-c',
    'user.name=Ada',
    '-c',
    'user.email=ada@harbor-labs.test',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init',
  );
  git(main, 'worktree', 'add', '-q', '-b', 'fix/flaky-login', worktree);
});

after(() => rmSync(root, { recursive: true, force: true }));

let data: string;
beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'joc-folder-data-'));
  process.env.CLAUDE_PLUGIN_DATA = data;
});
afterEach(() => {
  rmSync(data, { recursive: true, force: true });
  delete process.env.CLAUDE_PLUGIN_DATA;
});

/** What hook.ts does with one event: the folder it reports for the session. */
function report(
  input: Pick<HookInput, 'session_id' | 'hook_event_name' | 'cwd' | 'agent_id'>,
  at: number,
) {
  if (movesFolder(input)) rememberFolder(input.session_id, input.cwd, at);
  return placeOf(sessionFolder(input, rememberedFolder(input.session_id)));
}

test("a subagent's hook from another worktree doesn't change the session's branch", () => {
  const session = 'c3f1a2b4-0d9e-4c1b-9a77-5e2d8f6b1a90';
  report({ session_id: session, hook_event_name: 'SessionStart', cwd: main }, 1);
  const fromSubagent = report(
    { session_id: session, hook_event_name: 'PostToolUse', cwd: worktree, agent_id: 'a71c0e5f' },
    2,
  );
  assert.deepEqual(fromSubagent, { repo: 'harbor-labs/atlas-web', branch: 'main', worktree: '' });
  // Nor does the sync after it.
  const synced = report({ session_id: session, hook_event_name: 'Sync', cwd: main }, 3);
  assert.equal(synced.branch, 'main');
});

test('two sessions in one folder each report that folder, whatever the other does', () => {
  const a = '1b2c3d4e-aaaa-4bbb-8ccc-000000000001';
  const b = '1b2c3d4e-aaaa-4bbb-8ccc-000000000002';
  report({ session_id: a, hook_event_name: 'SessionStart', cwd: main }, 1);
  report({ session_id: b, hook_event_name: 'SessionStart', cwd: main }, 2);
  // Session a's subagent works in the worktree.
  report({ session_id: a, hook_event_name: 'PreToolUse', cwd: worktree, agent_id: 'a9' }, 3);
  for (const id of [a, b]) {
    assert.equal(report({ session_id: id, hook_event_name: 'Stop', cwd: main }, 4).branch, 'main');
    assert.equal(rememberedFolder(id)?.cwd, main);
  }
});

test('a session in its own worktree shows that branch and worktree, and follows it back', () => {
  const session = '7e6d5c4b-3a29-4180-9f8e-7d6c5b4a3921';
  report({ session_id: session, hook_event_name: 'SessionStart', cwd: main }, 1);
  // EnterWorktree: the session's own events now fire from the worktree.
  const moved = report({ session_id: session, hook_event_name: 'PostToolUse', cwd: worktree }, 2);
  assert.deepEqual(moved, {
    repo: 'harbor-labs/atlas-web',
    branch: 'fix/flaky-login',
    worktree: 'agent-a71c0e5f',
  });
  // A sync reads register.ts's folder, which may not follow: the remembered one wins.
  assert.equal(
    report({ session_id: session, hook_event_name: 'Sync', cwd: main }, 3).branch,
    'fix/flaky-login',
  );
  // ExitWorktree.
  const back = report({ session_id: session, hook_event_name: 'PostToolUse', cwd: main }, 4);
  assert.deepEqual(back, { repo: 'harbor-labs/atlas-web', branch: 'main', worktree: '' });
});

test('an older hook landing late never moves the folder back', () => {
  const session = '0a0b0c0d-1111-4222-8333-444455556666';
  rememberFolder(session, worktree, 5);
  rememberFolder(session, main, 4);
  assert.equal(rememberedFolder(session)?.cwd, worktree);
});

test("with nothing remembered, a subagent's event takes the session's folder from its transcript", () => {
  const input = { hook_event_name: 'PostToolUse', cwd: worktree, agent_id: 'a1' };
  assert.equal(
    sessionFolder(input, undefined, () => main),
    main,
  );
  assert.equal(
    sessionFolder(input, undefined, () => undefined),
    worktree,
  );
  assert.equal(
    sessionFolder({ hook_event_name: 'Stop', cwd: worktree }, { cwd: main, at: 1 }),
    worktree,
  );
});

test("the transcript's folder is its last own entry's, never a sidechain's", () => {
  const lines = [
    JSON.stringify({ type: 'user', cwd: '/work/atlas-web', isSidechain: false }),
    JSON.stringify({
      type: 'assistant',
      cwd: '/work/atlas-web/.claude/worktrees/x',
      isSidechain: true,
    }),
    JSON.stringify({ type: 'last-prompt' }),
    'not json',
  ];
  assert.equal(lastOwnCwd(lines), '/work/atlas-web');
  assert.equal(lastOwnCwd([]), undefined);
});

test('a subdirectory and a folder outside git are told apart from a worktree', () => {
  const sub = join(main, 'apps');
  mkdirSync(sub, { recursive: true });
  assert.deepEqual(placeOf(sub), { repo: 'harbor-labs/atlas-web', branch: 'main', worktree: '' });
  assert.deepEqual(parseTop('/work/notes', undefined), { name: 'notes', worktree: '' });
  assert.deepEqual(
    parseTop(
      '/work/atlas-web/.claude/worktrees/agent-b2',
      '/work/atlas-web/.claude/worktrees/agent-b2\n/work/atlas-web/.git/worktrees/agent-b2\n/work/atlas-web/.git',
    ),
    { name: 'atlas-web', worktree: 'agent-b2' },
  );
});

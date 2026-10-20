import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import {
  backgroundId,
  claudeFiles,
  isSessionId,
  pluginFiles,
  removePaths,
  runningByAgents,
  runningByRecords,
} from './forget.ts';

const ID = '3f2a1b0c-9d8e-4f7a-8b6c-5d4e3f2a1b0c';
/** Another session, whose id starts the same way. */
const OTHER = '3f2a1b0c-9d8e-4f7a-8b6c-5d4e3f2a1b0d';

let root: string;
let config: string;
let outside: string;

const file = (path: string, text = 'x') => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'joc-forget-')));
  config = join(root, 'claude');
  outside = join(root, 'elsewhere');
  mkdirSync(outside, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test('a session id is a UUID, and nothing else', () => {
  assert.equal(isSessionId(ID), true);
  for (const bad of ['', '..', '*', `${ID}/..`, ID.toUpperCase(), 'shared-id', 42]) {
    assert.equal(isSessionId(bad), false, String(bad));
  }
});

test("finds the session's transcript and the files Claude Code keys by its id, and nothing else", () => {
  const project = join(config, 'projects', '-Users-harbor-atlas-web');
  file(join(project, `${ID}.jsonl`));
  file(join(project, ID, 'subagents', 'agent-a1.jsonl'));
  file(join(project, `${OTHER}.jsonl`));
  file(join(project, OTHER, 'tool-results', 'r.txt'));
  file(join(config, 'file-history', ID, 'abc@v1'));
  file(join(config, 'session-env', ID, 'env'));
  file(join(config, 'debug', `${ID}.txt`));
  file(join(config, 'debug', `${OTHER}.txt`));
  file(join(config, 'history.jsonl'), JSON.stringify({ sessionId: ID }));
  file(join(config, 'tasks', `session-${ID.slice(0, 8)}`, 'state.json'));

  assert.deepEqual(
    claudeFiles(config, ID).sort(),
    [
      join(config, 'debug', `${ID}.txt`),
      join(config, 'file-history', ID),
      join(project, ID),
      join(project, `${ID}.jsonl`),
      join(config, 'session-env', ID),
    ].sort(),
  );
  assert.deepEqual(claudeFiles(config, 'not-an-id'), []);
});

test('never follows a link out of Claude Code’s folder', () => {
  // A project folder that is a link to elsewhere, and a transcript that is a link.
  file(join(outside, `${ID}.jsonl`), 'not yours');
  mkdirSync(join(config, 'projects', '-real'), { recursive: true });
  symlinkSync(outside, join(config, 'projects', '-linked'));
  symlinkSync(join(outside, `${ID}.jsonl`), join(config, 'projects', '-real', `${ID}.jsonl`));
  mkdirSync(join(outside, 'history'), { recursive: true });
  symlinkSync(join(outside, 'history'), join(config, 'file-history'));
  file(join(outside, 'history', ID, 'abc@v1'));

  assert.deepEqual(claudeFiles(config, ID), []);
  const { removed, failed } = removePaths(
    [
      join(config, 'projects', '-real', `${ID}.jsonl`),
      join(config, 'projects', '-linked', `${ID}.jsonl`),
    ],
    ID,
  );
  assert.deepEqual(removed, []);
  assert.equal(failed.length, 2);
  assert.equal(existsSync(join(outside, `${ID}.jsonl`)), true);
  assert.equal(existsSync(join(outside, 'history', ID, 'abc@v1')), true);
});

test("removes a folder's contents but not what a link inside it points at", () => {
  const folder = join(config, 'projects', '-p', ID);
  file(join(folder, 'tool-results', 'r.txt'));
  file(join(outside, 'keep.txt'), 'keep');
  symlinkSync(join(outside, 'keep.txt'), join(folder, 'link.txt'));
  const { removed } = removePaths(claudeFiles(config, ID), ID);
  assert.deepEqual(removed, [folder]);
  assert.equal(existsSync(folder), false);
  assert.equal(existsSync(join(outside, 'keep.txt')), true);
});

test('refuses to remove anything not named by the session id', () => {
  file(join(config, 'debug', `${OTHER}.txt`));
  file(join(config, 'history.jsonl'));
  const { removed, failed } = removePaths(
    [join(config, 'debug', `${OTHER}.txt`), join(config, 'history.jsonl'), config],
    ID,
  );
  assert.deepEqual(removed, []);
  assert.equal(failed.length, 3);
  assert.equal(readdirSync(join(config, 'debug')).length, 1);
});

test("finds the plugin's own read positions, diff hash and last state for the session", () => {
  const data = join(root, 'data');
  file(join(data, 'offsets', `${ID}.offset`));
  file(join(data, 'offsets', `${ID}_agent-a00ff4898eedbbd11.offset`));
  file(join(data, 'offsets', `${OTHER}.offset`));
  file(join(data, 'changes', `${ID}.hash`));
  file(join(data, 'changes', `${OTHER}.hash`));
  file(join(data, 'reported', `${ID}.json`));
  file(join(data, 'reported', `${OTHER}.json`));
  assert.deepEqual(pluginFiles([data, join(root, 'missing')], ID).sort(), [
    join(data, 'changes', `${ID}.hash`),
    join(data, 'offsets', `${ID}.offset`),
    join(data, 'offsets', `${ID}_agent-a00ff4898eedbbd11.offset`),
    join(data, 'reported', `${ID}.json`),
  ]);
});

test("Claude Code's records of its running processes say whether one has the session", () => {
  const sessions = join(config, 'sessions');
  file(join(sessions, '111.json'), JSON.stringify({ pid: 111, sessionId: ID }));
  file(join(sessions, '222.json'), JSON.stringify({ pid: 222, sessionId: OTHER }));
  file(join(sessions, '333.json'), '{ half-writ');
  assert.equal(
    runningByRecords(config, ID, (pid) => pid === 111),
    true,
  );
  // Its process exited, but the record stayed behind.
  assert.equal(
    runningByRecords(config, ID, () => false),
    false,
  );
  assert.equal(runningByRecords(join(root, 'never-ran'), ID), false);
});

test('claude agents says which sessions run, and the short id of a background one', () => {
  const listed = JSON.stringify([
    { pid: 1, kind: 'interactive', sessionId: OTHER },
    { id: '3f2a1b0c', kind: 'background', sessionId: ID, state: 'done' },
  ]);
  assert.equal(runningByAgents(listed, ID), true);
  assert.equal(runningByAgents('[]', ID), false);
  assert.equal(runningByAgents('Error: not logged in', ID), undefined);
  assert.equal(backgroundId(listed, ID), '3f2a1b0c');
  assert.equal(backgroundId(listed, OTHER), undefined);
  const odd = JSON.stringify([{ id: '--force', kind: 'background', sessionId: ID }]);
  assert.equal(backgroundId(odd, ID), undefined);
});

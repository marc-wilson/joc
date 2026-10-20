import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resumeOutcome, tilde, transcriptPath } from './resume-session.ts';

const ID = '7d2e0fea-88c0-44e6-a26c-0ef30c662fec';

test('a resume that continued the session itself is ok', () => {
  const stdout = [
    'note: woke session 7d2e0fea with its saved options (--settings, --name).',
    'backgrounded · 7d2e0fea · atlas-web',
    '  claude attach 7d2e0fea    open in this terminal',
  ].join('\n');
  assert.deepEqual(resumeOutcome(ID, { code: 0, stdout, stderr: '' }), { ok: true });
});

test('a copy under another id is not a resume, and says so', () => {
  const note =
    'note: session 7d2e0fea is already running in the background, so this started a copy as 1c0f1970.';
  const stdout = `${note}\nbackgrounded · 1c0f1970 (idle — send a prompt to start)`;
  assert.deepEqual(resumeOutcome(ID, { code: 0, stdout, stderr: '' }), {
    ok: false,
    reason: 'it was already running, so claude started a copy',
    detail: note,
  });
});

test('a failed claude says its exit code and its last line', () => {
  const run = { code: 1, stdout: '', stderr: 'Error: something broke\nNo conversation found\n' };
  assert.deepEqual(resumeOutcome(ID, run), {
    ok: false,
    reason: 'claude exited with code 1',
    detail: 'No conversation found',
  });
  assert.equal(resumeOutcome(ID, { code: 0, stdout: 'hello', stderr: '' }).ok, false);
});

test('paths read from the home folder, as Claude Code names a project', () => {
  assert.equal(tilde('/Users/ada/code/atlas-web', '/Users/ada'), '~/code/atlas-web');
  assert.equal(tilde('/srv/atlas-web', '/Users/ada'), '/srv/atlas-web');
  assert.equal(
    transcriptPath('/Users/ada/.claude', '/Users/ada/code/atlas.web', ID),
    `/Users/ada/.claude/projects/-Users-ada-code-atlas-web/${ID}.jsonl`,
  );
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resumeCommand, shortId, shortPath } from './resume.ts';

test('the resume command changes to the folder first, quoting it', () => {
  assert.equal(resumeCommand('abc'), 'claude --resume abc');
  assert.equal(
    resumeCommand('abc', '/Users/ada/Code/atlas web'),
    "cd '/Users/ada/Code/atlas web' && claude --resume abc",
  );
  assert.equal(
    resumeCommand('abc', "/work/it's here"),
    "cd '/work/it'\\''s here' && claude --resume abc",
  );
});

test('a session ID shortens to 8 characters', () => {
  assert.equal(shortId('4f2a9c1e-7b3d-4a51-9c2e-0d8f6b1a2e77'), '4f2a9c1e');
  assert.equal(shortId('abc'), 'abc');
});

test('a path shortens to its last three folders', () => {
  assert.equal(shortPath('/Users/ada/Code/atlas-web/apps/web'), '…/atlas-web/apps/web');
  assert.equal(shortPath('/Users/ada/Code'), '/Users/ada/Code');
  assert.equal(shortPath('/srv/atlas'), '/srv/atlas');
});

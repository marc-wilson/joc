import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JOC_NEW_ISSUE_URL, JOC_REPO_URL } from './repo.ts';

test('the new issue form is on the same repository the nav links to', () => {
  assert.equal(JOC_REPO_URL, 'https://github.com/marc-wilson/joc');
  assert.equal(JOC_NEW_ISSUE_URL, 'https://github.com/marc-wilson/joc/issues/new');
});

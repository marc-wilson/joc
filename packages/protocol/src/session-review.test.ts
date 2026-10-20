import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewOfPrompt, reviewOutcome, reviewPrompt } from './index.ts';

const repo = 'harbor-labs/atlas-web';
const url = 'https://github.com/harbor-labs/ledger-api/pull/88';

test('a review command on a PR number reviews that PR on the session repo', () => {
  assert.deepEqual(reviewOfPrompt('/code-review 512', repo), { repo, number: 512 });
  assert.deepEqual(reviewOfPrompt('  /code-review #7 ', repo), { repo, number: 7 });
  assert.deepEqual(reviewOfPrompt('/harbor:review-pr 9', repo), { repo, number: 9 });
});

test('a review command on a PR address reviews that PR, whatever the session repo', () => {
  const pr = { repo: 'harbor-labs/ledger-api', number: 88, url };
  assert.deepEqual(reviewOfPrompt(`/prep-pr ${url}`, repo), pr);
  assert.deepEqual(reviewOfPrompt(`/code-review ${url}/files`, repo), pr);
});

test('the prompts JOC starts reviews with count as reviews', () => {
  const pr = { number: 42, url: 'https://github.com/harbor-labs/atlas-web/pull/42' };
  assert.equal(reviewOfPrompt(reviewPrompt(pr), repo)?.number, 42);
  assert.equal(reviewOfPrompt(reviewPrompt(pr, '/prep-pr'), repo)?.number, 42);
});

test('anything else is not a review', () => {
  for (const prompt of [
    undefined,
    '',
    '/code-review',
    '/prep-pr',
    '/fix-ci 512',
    'review 512',
    'Please /code-review 512',
    `/deploy ${url}`,
    '/code-review the auth module',
  ]) {
    assert.equal(reviewOfPrompt(prompt, repo), undefined, String(prompt));
  }
  // Outside a GitHub repo, a number names no PR.
  assert.equal(reviewOfPrompt('/code-review 4', 'scratch'), undefined);
});

test("a review's outcome is what Claude's last message says, or unknown", () => {
  assert.equal(reviewOutcome('Approved: the change is small and tested.'), 'Approved');
  assert.equal(reviewOutcome('LGTM, approving.'), 'Approved');
  assert.equal(reviewOutcome('Requested changes: 3 issues in auth.ts'), 'Changes requested');
  assert.equal(reviewOutcome('Changes requested on #512'), 'Changes requested');
  assert.equal(reviewOutcome('Posted 6 comments on the PR'), 'Commented');
  assert.equal(reviewOutcome("I can't approve this yet: the tests fail."), undefined);
  assert.equal(reviewOutcome("I haven't approved it: two questions first."), undefined);
  assert.equal(reviewOutcome('Not approved yet.'), undefined);
  assert.equal(reviewOutcome('Done'), undefined);
  assert.equal(reviewOutcome(undefined), undefined);
});

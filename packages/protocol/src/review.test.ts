import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LaunchRequest, ReviewSettings, reviewPrompt } from './index.ts';

const pr = { number: 42, url: 'https://github.com/harbor-labs/atlas-web/pull/42' };

test('with no instructions, Claude reviews the PR number', () => {
  assert.equal(reviewPrompt(pr), '/code-review 42');
  assert.equal(reviewPrompt(pr, '  '), '/code-review 42');
});

test("the person's command gets the PR filled in, or its address after it", () => {
  assert.equal(reviewPrompt(pr, '/prep-pr'), `/prep-pr ${pr.url}`);
  assert.equal(reviewPrompt(pr, '  /harbor:review {pr} '), '/harbor:review 42');
  assert.equal(reviewPrompt(pr, 'Review {url} as #{pr}'), `Review ${pr.url} as #42`);
});

test("the person's own prompt gets the PR's address on a line of its own", () => {
  const prompt = 'Review this pull request.\nLook hard at the tests.';
  assert.equal(reviewPrompt(pr, prompt), `${prompt}\n\nThe pull request: ${pr.url}`);
  // A sentence that isn't a command reads the same way.
  assert.equal(reviewPrompt(pr, 'Check it'), `Check it\n\nThe pull request: ${pr.url}`);
});

test('review settings may be empty, but not endless', () => {
  assert.equal(ReviewSettings.safeParse({}).success, true);
  assert.deepEqual(ReviewSettings.parse({ instructions: ' /prep-pr ' }), {
    instructions: '/prep-pr',
  });
  assert.equal(ReviewSettings.safeParse({ instructions: 'x'.repeat(20_001) }).success, false);
});

test('a launch names the session it starts from', () => {
  assert.equal(LaunchRequest.safeParse({}).success, false);
  assert.equal(LaunchRequest.safeParse({ from: 's1' }).success, true);
  assert.equal(
    LaunchRequest.safeParse({ from: 's1', review: { ...pr, repo: 'harbor-labs/atlas-web' } })
      .success,
    true,
  );
});

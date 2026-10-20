import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReviewRequest, reviewPrompt } from './index.ts';

const pr = { number: 42, url: 'https://github.com/harbor-labs/atlas-web/pull/42' };

test('the standard review gets the PR number', () => {
  assert.equal(reviewPrompt(pr, 'standard'), '/code-review 42');
  // A remembered command of their own doesn't change the standard review.
  assert.equal(reviewPrompt(pr, 'standard', '/prep-pr'), '/code-review 42');
});

test("the person's own command gets the PR filled in, or its address after it", () => {
  assert.equal(reviewPrompt(pr, 'own', '/prep-pr'), `/prep-pr ${pr.url}`);
  assert.equal(reviewPrompt(pr, 'own', '  /harbor:review {pr} '), '/harbor:review 42');
  assert.equal(reviewPrompt(pr, 'own', 'Review {url} as #{pr}'), `Review ${pr.url} as #42`);
  // No command: nothing of theirs to run, so the standard review.
  assert.equal(reviewPrompt(pr, 'own', ' '), '/code-review 42');
});

test('a review request of their own needs a command', () => {
  const base = { repo: 'harbor-labs/atlas-web', ...pr, target: { kind: 'new', from: 's1' } };
  assert.equal(ReviewRequest.safeParse({ ...base, method: 'standard' }).success, true);
  assert.equal(ReviewRequest.safeParse({ ...base, method: 'own' }).success, false);
  assert.equal(ReviewRequest.safeParse({ ...base, method: 'own', command: '  ' }).success, false);
  assert.equal(
    ReviewRequest.safeParse({ ...base, method: 'own', command: '/prep-pr' }).success,
    true,
  );
});

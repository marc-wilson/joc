import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clipBody, closingIssues, MAX_PR_BODY, PullRequest, ReviewedPullRequest } from './index.ts';

const REPO = 'harbor-labs/atlas-web';

test('a description is kept up to the limit, and says when it was cut', () => {
  assert.deepEqual(clipBody(null), {});
  assert.deepEqual(clipBody(''), {});
  assert.deepEqual(clipBody('Fixes the redirect.'), { body: 'Fixes the redirect.' });
  const long = clipBody('a'.repeat(MAX_PR_BODY + 5));
  assert.equal(long.body?.length, MAX_PR_BODY);
  assert.equal(long.bodyTruncated, true);
  // Never half a character at the cut.
  const emoji = clipBody(`${'a'.repeat(9)}\u{1F600}b`, 10);
  assert.deepEqual(emoji, { body: 'a'.repeat(9), bodyTruncated: true });
});

test('closing keywords name the issues a pull request closes, outside code', () => {
  const body = [
    'Closes #12, fixes harbor-labs/atlas-api#3.',
    'Resolves: https://github.com/harbor-labs/atlas-web/issues/40',
    'closes #12 again, and refs #99',
    'Not `fixes #77`, nor:',
    '```\nresolves #78\n```',
    'prefixes #5 and fix#6 are not keywords',
  ].join('\n');
  assert.deepEqual(
    closingIssues(body, REPO).map((i) => `${i.repo}#${i.number}`),
    ['harbor-labs/atlas-web#12', 'harbor-labs/atlas-api#3', 'harbor-labs/atlas-web#40'],
  );
  assert.equal(
    closingIssues('Fixed #8', REPO)[0]?.url,
    'https://github.com/harbor-labs/atlas-web/issues/8',
  );
  assert.deepEqual(closingIssues(undefined, REPO), []);
});

const base = {
  number: 7,
  title: 'Fix the auth redirect',
  url: `https://github.com/${REPO}/pull/7`,
  repo: REPO,
  branch: 'fix/7',
  author: 'alice',
  updatedAt: '2026-10-20T09:00:00.000Z',
  draft: false,
  additions: 1,
  deletions: 0,
  ci: 'pass',
};

test('a pull request without the review details still parses, as old data does', () => {
  assert.equal(PullRequest.safeParse(base).success, true);
  const review = { repo: REPO, number: 7 };
  assert.equal(ReviewedPullRequest.safeParse({ review }).success, true);
});

test("an avatar from anywhere but GitHub's image host is refused", () => {
  const withAvatar = (avatarUrl: string) =>
    PullRequest.safeParse({ ...base, authorProfile: { login: 'alice', avatarUrl } }).success;
  assert.equal(withAvatar('https://avatars.githubusercontent.com/u/1?v=4'), true);
  assert.equal(withAvatar('https://avatars.githubusercontent.com.evil.example/u/1'), false);
  assert.equal(withAvatar('http://avatars.githubusercontent.com/u/1'), false);
  assert.equal(withAvatar('https://tracker.example/pixel.png'), false);
});

test("a label's colour is six hex digits", () => {
  const withLabel = (color: string) =>
    PullRequest.safeParse({ ...base, labels: [{ name: 'bug', color }] }).success;
  assert.equal(withLabel('d73a4a'), true);
  assert.equal(withLabel('#d73a4a'), false);
  assert.equal(withLabel('red'), false);
});

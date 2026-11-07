import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isUnread } from './index.ts';

const early = '2026-10-18T10:00:00.000Z';
const late = '2026-10-18T10:05:00.000Z';

test('a session is unread from a reply until you read it', () => {
  assert.equal(isUnread({}), false);
  assert.equal(isUnread({ readAt: early }), false);
  assert.equal(isUnread({ repliedAt: early }), true);
  assert.equal(isUnread({ repliedAt: late, readAt: early }), true);
  assert.equal(isUnread({ repliedAt: early, readAt: late }), false);
});

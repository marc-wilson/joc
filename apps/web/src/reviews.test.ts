import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CIStatus } from '@joc/protocol';
import { checksBadge } from './reviews.ts';

const checks = (...statuses: CIStatus[]) =>
  statuses.map((status, i) => ({ name: `c${i}`, status }));

test('the checks badge leads with what needs you, then counts the rest', () => {
  assert.deepEqual(
    // As the design counts its six: a skipped check counts as passed.
    checksBadge(checks('pass', 'fail', 'pass', 'pass', 'pending', 'skipped')),
    {
      status: 'fail',
      label: '1 failing',
      detail: '4 passed · 1 running',
    },
  );
  assert.deepEqual(checksBadge(checks('pass', 'pending', 'pending')), {
    status: 'pending',
    label: '2 running',
    detail: '1 passed',
  });
  assert.deepEqual(checksBadge(checks('fail')), {
    status: 'fail',
    label: '1 failing',
    detail: undefined,
  });
  assert.deepEqual(checksBadge(checks('pass', 'skipped')), { status: 'pass', label: '2 passed' });
  assert.deepEqual(checksBadge(checks('skipped', 'skipped')), {
    status: 'skipped',
    label: '2 skipped',
  });
});

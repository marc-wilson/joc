import assert from 'node:assert/strict';
import { test } from 'node:test';
import { movedIds, waitingCount } from './resort.ts';

test('a settle fades only the rows that change slot, and the ones leaving', () => {
  assert.deepEqual(movedIds(['a', 'b', 'c', 'd'], ['a', 'c', 'b', 'd']), ['b', 'c']);
  assert.deepEqual(movedIds(['a', 'b', 'c'], ['a', 'b', 'c']), []);
  assert.deepEqual(movedIds(['a', 'gone', 'b'], ['a', 'b']), ['gone', 'b']);
});

test('the count says how few rows have to move, plus the ones leaving', () => {
  // One row moving up past another is one waiting, not two.
  assert.equal(waitingCount(['a', 'b', 'c', 'd'], ['a', 'c', 'b', 'd']), 1);
  assert.equal(waitingCount(['a', 'b', 'c', 'd'], ['d', 'a', 'b', 'c']), 1);
  assert.equal(waitingCount(['a', 'b', 'c'], ['c', 'b', 'a']), 2);
  assert.equal(waitingCount(['a', 'b'], ['a', 'b']), 0);
  assert.equal(waitingCount(['a', 'gone', 'b'], ['a', 'b']), 1);
});

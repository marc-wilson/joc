import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stamp } from './time.ts';

test('a stamp is the date and the 24-hour time, with the year only when it is another', () => {
  const now = new Date(2026, 9, 20, 12, 0).getTime();
  assert.equal(stamp(new Date(2026, 9, 9, 11, 2).toISOString(), now), 'Oct 9 11:02');
  assert.equal(stamp(new Date(2025, 11, 30, 9, 48).toISOString(), now), 'Dec 30 2025 09:48');
  assert.equal(stamp(new Date(2026, 9, 20, 9, 12).toISOString(), now), 'Today 09:12');
  assert.equal(stamp(new Date(2026, 9, 19, 17, 40).toISOString(), now), 'Yesterday 17:40');
});

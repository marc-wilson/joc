import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitPieces } from './ops-fit.ts';

const pieces = [
  { text: '#484 Merged', glyph: true, priority: 3 },
  { text: 'CI passed', glyph: true, priority: 2 },
  { text: 'Approved', glyph: true, priority: 2 },
  { text: 'Merged 38m ago', glyph: true, priority: 2 },
  { text: 'Deploying', glyph: true, priority: 1 },
];

test('everything stays when it fits, and before the cell is measured', () => {
  assert.equal(fitPieces(pieces, 1000, 1).dropped.length, 0);
  assert.equal(fitPieces(pieces, 0, 1).dropped.length, 0);
});

test('two lines wrap before anything drops', () => {
  assert.equal(fitPieces(pieces, 300, 2).dropped.length, 0);
});

test('narrow, the pull request drops first, then middle stages, never a failure', () => {
  const one = fitPieces(pieces, 300, 1);
  assert.equal(one.dropped[0]?.text, '#484 Merged');
  assert.ok(one.kept.some((p) => p.text === 'Deploying'));
  const failing = [
    { text: '#479 Open', glyph: true, priority: 3 },
    { text: 'CI failed 2', glyph: true, priority: 0 },
    { text: 'Commented', glyph: true, priority: 1 },
  ];
  const tight = fitPieces(failing, 120, 1);
  assert.deepEqual(
    tight.kept.map((p) => p.text),
    ['CI failed 2'],
  );
  // Dropped ones keep the stages' order, for the "+N" tag's title.
  assert.deepEqual(
    tight.dropped.map((p) => p.text),
    ['#479 Open', 'Commented'],
  );
});

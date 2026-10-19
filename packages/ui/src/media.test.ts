import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attachedHint, formatBytes, imageTypeName, stepIndex } from './media.ts';

test('file sizes read in bytes, then KB, then MB to one place', () => {
  assert.equal(formatBytes(840), '840 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(98_304), '96 KB');
  assert.equal(formatBytes(1_258_291), '1.2 MB');
});

test('image types read as short names', () => {
  assert.equal(imageTypeName('image/png'), 'PNG');
  assert.equal(imageTypeName('image/jpeg'), 'JPEG');
  assert.equal(imageTypeName('image/webp'), 'WebP');
  assert.equal(imageTypeName('image/avif'), 'AVIF');
});

test('stepping through images holds at the first and last', () => {
  assert.equal(stepIndex(1, 1, 3), 2);
  assert.equal(stepIndex(1, -1, 3), 0);
  assert.equal(stepIndex(2, 1, 3), 2);
  assert.equal(stepIndex(0, -1, 3), 0);
  assert.equal(stepIndex(0, 1, 1), 0);
});

test('the composer hint counts the images and says what Enter does', () => {
  assert.equal(attachedHint(1, 3, true), '1 image · paste or drop more');
  assert.equal(attachedHint(3, 3, false), '3 images · ↵ sends them without a message');
  assert.equal(attachedHint(1, 3, false), '1 image · ↵ sends it without a message');
  assert.equal(attachedHint(3, 3, true), '3 images, the most a message takes');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { githubByApp } from './github-source.ts';

test('only an answer saying the App covers the person stops the gh reads', () => {
  assert.equal(githubByApp(new Headers({ 'x-joc-github': 'app' })), true);
  assert.equal(githubByApp(new Headers()), false);
  assert.equal(githubByApp(new Headers({ 'x-joc-github': 'plugin' })), false);
});

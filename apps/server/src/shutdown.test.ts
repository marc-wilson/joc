// On shutdown, live streams end so browsers reconnect to the server taking over. Runs against
// the run's MongoDB.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { closeClient } from '@joc/db';
import { createApp } from './app.ts';
import { useTestDb } from './test-db.ts';

before(async () => {
  await useTestDb('joc_shutdown_test');
});

after(async () => {
  await closeClient();
});

// The timeout is well under the stream's 15s ping pause, so only the shutdown can end it in time.
test('a live stream ends when the server shuts down', { timeout: 5000 }, async () => {
  const shutdown = new AbortController();
  const app = createApp({
    publicUrl: 'http://joc.test',
    pluginVersion: '1.0.0',
    shutdown: shutdown.signal,
  });
  const res = await app.request('/api/stream');
  assert.equal(res.status, 200);
  const reader = res.body?.getReader();
  assert.ok(reader);

  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes('event: snapshot')) {
    const { done, value } = await reader.read();
    assert.equal(done, false, 'the stream ended before its snapshot');
    text += decoder.decode(value);
  }

  shutdown.abort();
  while (!(await reader.read()).done) {
    // Drain until the server ends the stream.
  }
});

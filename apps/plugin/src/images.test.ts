import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { imageLine, takeImageLines } from './images.ts';
import { parseLines, readNewLines } from './transcript.ts';

const t = '2026-10-18T10:00:00.000Z';
const ID = 'a'.repeat(64);
// Stand-ins for image bytes: the parser never decodes them.
const image = (data: string, media_type = 'image/png') => ({
  type: 'image',
  source: { type: 'base64', media_type, data },
});
const user = (uuid: string, content: unknown) =>
  JSON.stringify({ type: 'user', uuid, timestamp: t, message: { role: 'user', content } });

test('pasted images go with the text of their message', () => {
  const { items, images } = parseLines(
    [
      user('u1', [
        { type: 'text', text: 'Why is this red? [Image #1]' },
        image('AAAA'),
        image('BBBB', 'image/jpeg'),
      ]),
    ],
    '/work',
  );
  assert.deepEqual(
    items.map((i) => [i.id, i.kind]),
    [['u1:0', 'user']],
  );
  assert.deepEqual(images, [
    { itemId: 'u1:0', type: 'image/png', data: 'AAAA' },
    { itemId: 'u1:0', type: 'image/jpeg', data: 'BBBB' },
  ]);
});

test('images alone make an item of their own; unknown formats and URLs are skipped', () => {
  const { items, images } = parseLines(
    [
      user('u1', [
        image('AAAA'),
        image('PHN2Zz4=', 'image/svg+xml'),
        { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
      ]),
    ],
    '/work',
  );
  assert.deepEqual(items, [{ id: 'u1:images', at: t, kind: 'user', text: '' }]);
  assert.deepEqual(images, [{ itemId: 'u1:images', type: 'image/png', data: 'AAAA' }]);
});

test('a message carries at most ten images', () => {
  const blocks = Array.from({ length: 12 }, (_, i) => image(`IMG${i}`));
  assert.equal(parseLines([user('u1', blocks)], '/work').images.length, 10);
});

test("images Claude's tools returned are not pasted images", () => {
  const { images } = parseLines(
    [user('u1', [{ type: 'tool_result', tool_use_id: 't1', content: [image('AAAA')] }])],
    '/work',
  );
  assert.deepEqual(images, []);
});

test('the image lines of a dashboard prompt become its images', () => {
  const text = `Look at this\n\n${imageLine(`/home/x/.claude/joc/images/${ID}.png`)}`;
  assert.deepEqual(takeImageLines(text), {
    text: 'Look at this',
    images: [{ id: ID, type: 'image/png' }],
  });
  const { items } = parseLines([user('u1', text)], '/work');
  assert.deepEqual(items, [
    {
      id: 'u1',
      at: t,
      kind: 'user',
      text: 'Look at this',
      images: [{ id: ID, type: 'image/png' }],
    },
  ]);
  // Anything that isn't a JOC image file stays text.
  const other = '[Image from JOC: /tmp/notes.txt]';
  assert.deepEqual(takeImageLines(other), { text: other, images: [] });
});

test('a long line at the start of a read is read whole', () => {
  const dir = mkdtempSync(join(tmpdir(), 'joc-lines-test-'));
  process.env.CLAUDE_PLUGIN_DATA = join(dir, 'data');
  try {
    const transcript = join(dir, 't.jsonl');
    writeFileSync(transcript, `${user('u1', 'first')}\n`);
    readNewLines('long-line', transcript).commit();
    // Over the 1 MB a read normally takes, as one line: a big pasted screenshot.
    const big = user('u2', [{ type: 'text', text: 'big' }, image('A'.repeat(1_500_000))]);
    appendFileSync(transcript, `${big}\n${user('u3', 'after')}\n`);
    const { lines } = readNewLines('long-line', transcript);
    assert.deepEqual(
      parseLines(lines, '/work').items.map((i) => i.id),
      ['u2:0', 'u3'],
    );
  } finally {
    delete process.env.CLAUDE_PLUGIN_DATA;
    rmSync(dir, { recursive: true, force: true });
  }
});

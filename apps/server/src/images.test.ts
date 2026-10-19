// Image uploads: only real PNG, JPEG, GIF and WebP bytes, at most 5 MB, served so a browser
// never runs them. Runs against an in-memory MongoDB, open local mode.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { closeClient } from '@joc/db';
import { ClaimedPrompt, ImageRef, MAX_IMAGE_BYTES } from '@joc/protocol';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { z } from 'zod';
import { createApp } from './app.ts';
import { sniffImageType } from './images.ts';

let mongo: MongoMemoryServer;

before(async () => {
  mongo = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongo.getUri();
  process.env.MONGODB_DB = 'joc_images_test';
});

after(async () => {
  await closeClient();
  await mongo.stop();
});

const app = createApp({ publicUrl: 'http://joc.test', pluginVersion: '1.0.0' });

const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...Buffer.from(p)] : p)));

// Tiny made-up files: each format's signature, then a few bytes of its own.
const PNG = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'harbor');
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0], 'harbor');
const GIF = bytes('GIF89a', 'harbor');
const WEBP = bytes('RIFF', [0x10, 0, 0, 0], 'WEBPVP8 ', 'harbor');
const SVG = bytes('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

const upload = (body: Uint8Array, type: string) =>
  app.request('/api/images', { method: 'POST', headers: { 'content-type': type }, body });

test('formats are told apart by their bytes', () => {
  assert.equal(sniffImageType(PNG), 'image/png');
  assert.equal(sniffImageType(JPEG), 'image/jpeg');
  assert.equal(sniffImageType(GIF), 'image/gif');
  assert.equal(sniffImageType(WEBP), 'image/webp');
  assert.equal(sniffImageType(SVG), undefined);
  assert.equal(sniffImageType(bytes('RIFF', [0, 0, 0, 0], 'WAVE')), undefined);
  assert.equal(sniffImageType(new Uint8Array()), undefined);
});

test('each allowed format uploads, named by the hash of its bytes', async () => {
  for (const [body, type] of [
    [PNG, 'image/png'],
    [JPEG, 'image/jpeg'],
    [GIF, 'image/gif'],
    [WEBP, 'image/webp'],
  ] as const) {
    const res = await upload(body, type);
    assert.equal(res.status, 201, type);
    const image = ImageRef.parse(await res.json());
    assert.equal(image.type, type);
    assert.equal(image.bytes, body.length);
  }
  const first = ImageRef.parse(await (await upload(PNG, 'image/png')).json());
  const again = ImageRef.parse(await (await upload(PNG, 'image/png')).json());
  assert.equal(first.id, again.id);
});

test('SVG, unknown bytes and a false Content-Type are refused', async () => {
  assert.equal((await upload(SVG, 'image/svg+xml')).status, 415);
  assert.equal((await upload(SVG, 'image/png')).status, 415);
  assert.equal((await upload(bytes('just text'), 'image/png')).status, 415);
  // Real PNG bytes, declared as something else.
  assert.equal((await upload(PNG, 'image/gif')).status, 415);
  assert.equal((await upload(PNG, 'text/html')).status, 415);
});

test('an image over 5 MB is refused', async () => {
  const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
  big.set(PNG);
  assert.equal((await upload(big, 'image/png')).status, 413);
});

test('an image is served with its type, never sniffed, and kept private', async () => {
  const { id } = ImageRef.parse(await (await upload(GIF, 'image/gif')).json());
  const res = await app.request(`/api/images/${id}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/gif');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('cache-control') ?? '', /^private\b/);
  assert.match(res.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), GIF);
});

test('ids that are not image ids are not found', async () => {
  for (const id of ['nope', '..%2F..%2Fetc', 'A'.repeat(64)]) {
    assert.equal((await app.request(`/api/images/${id}`)).status, 404, id);
  }
});

test('a prompt takes images, and needs text or an image', async () => {
  const image = ImageRef.parse(await (await upload(JPEG, 'image/jpeg')).json());
  const send = (body: unknown) =>
    app.request('/api/sessions/s/prompts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  assert.equal((await send({ text: '', images: [image.id] })).status, 201);
  assert.equal((await send({ text: '  ' })).status, 400);
  assert.equal((await send({ text: 'x', images: Array(11).fill(image.id) })).status, 400);
  assert.equal((await send({ text: 'x', images: ['f'.repeat(64)] })).status, 400);

  const claim = await app.request('/api/sessions/s/prompts/claim', { method: 'POST' });
  const { prompts } = z.object({ prompts: z.array(ClaimedPrompt) }).parse(await claim.json());
  assert.deepEqual(prompts[0]?.images, [image]);
});

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';

// Runs save-images.ts as register.ts does for a prompt with images, against a stand-in server.

const script = join(import.meta.dirname, 'save-images.ts');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x68, 0x62]);
const GOOD = 'b'.repeat(64);
const WRONG_TYPE = 'd'.repeat(64);

let server: Server;
let serverUrl: string;
let asked: string[];

before(async () => {
  server = createServer((req, res) => {
    asked.push(req.url ?? '');
    if (req.url === `/api/images/${GOOD}`) {
      res.setHeader('content-type', 'image/png');
      res.end(PNG);
    } else if (req.url === `/api/images/${WRONG_TYPE}`) {
      res.setHeader('content-type', 'text/html');
      res.end('<script>alert(1)</script>');
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  serverUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

after(() => server.close());

let home: string;
const imagesDir = () => join(home, '.claude', 'joc', 'images');

beforeEach(() => {
  asked = [];
  home = mkdtempSync(join(tmpdir(), 'joc-save-images-test-'));
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

function run(input: unknown): Promise<string[]> {
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, HOME: home, JOC_URL: serverUrl, JOC_TOKEN: '' },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let out = '';
  child.stdout.on('data', (chunk) => {
    out += chunk;
  });
  child.stdin.end(JSON.stringify(input));
  return new Promise((resolve) =>
    child.on('exit', () => resolve(out ? JSON.parse(out).lines : [])),
  );
}

test('an image is saved in JOC’s own folder, named by its id, and named in the prompt', async () => {
  const lines = await run({ images: [{ id: GOOD, type: 'image/png' }] });
  const path = join(imagesDir(), `${GOOD}.png`);
  assert.deepEqual(lines, [`[Image from JOC: ${path}]`]);
  assert.deepEqual(readFileSync(path), PNG);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(imagesDir()).mode & 0o777, 0o700);
});

test('ids that are not server-made never reach a path or the server', async () => {
  const lines = await run({
    images: [
      { id: '../../../.ssh/authorized_keys', type: 'image/png' },
      { id: GOOD, type: 'image/svg+xml' },
      { id: 'e'.repeat(64), type: 'image/png' },
    ],
  });
  assert.deepEqual(lines, Array(3).fill('[An image sent from JOC could not be loaded]'));
  assert.deepEqual(asked, [`/api/images/${'e'.repeat(64)}`]);
  assert.deepEqual(readdirSync(imagesDir()), []);
});

test('a reply that is not the image it should be is not saved', async () => {
  const lines = await run({ images: [{ id: WRONG_TYPE, type: 'image/png' }] });
  assert.deepEqual(lines, ['[An image sent from JOC could not be loaded]']);
  assert.equal(existsSync(join(imagesDir(), `${WRONG_TYPE}.png`)), false);
});

test('images saved over a week ago are cleared', async () => {
  mkdirSync(imagesDir(), { recursive: true });
  const old = join(imagesDir(), `${'f'.repeat(64)}.png`);
  writeFileSync(old, PNG);
  const weekAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
  utimesSync(old, weekAgo, weekAgo);
  await run({ images: [{ id: GOOD, type: 'image/png' }] });
  assert.deepEqual(readdirSync(imagesDir()), [`${GOOD}.png`]);
});

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { findTranscript } from './transcript.ts';

// Runs hook.ts as register.ts does on each sync, against a stand-in server.

const hookScript = join(import.meta.dirname, 'hook.ts');
const sessionId = 'sync-test-session';

let root: string;
let server: Server;
let serverUrl: string;
let received: { path: string; body: Record<string, unknown>; plugin?: string | string[] }[];
let messagesStatus: number;
let imagesStatus: number;
const IMAGE_ID = 'c'.repeat(64);

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const data = Buffer.concat(chunks);
      if (req.url === '/api/images') {
        // Images come as their raw bytes; the stand-in answers as the server would.
        received.push({
          path: req.url,
          plugin: req.headers['x-joc-plugin'],
          body: { type: req.headers['content-type'], bytes: data.toString('latin1') },
        });
        res.statusCode = imagesStatus;
        res.end(JSON.stringify({ id: IMAGE_ID, type: 'image/png', bytes: data.length }));
        return;
      }
      received.push({
        path: req.url ?? '',
        body: JSON.parse(data.toString('utf8')),
        plugin: req.headers['x-joc-plugin'],
      });
      res.statusCode = req.url === '/api/messages' ? messagesStatus : 200;
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  serverUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

after(() => server.close());

let cwd: string;
let transcript: string;

beforeEach(() => {
  received = [];
  messagesStatus = 200;
  imagesStatus = 201;
  root = mkdtempSync(join(tmpdir(), 'joc-sync-test-'));
  cwd = join(root, 'atlas-web');
  mkdirSync(cwd);
  const git = (...args: string[]) =>
    execFileSync('git', [
      '-C',
      cwd,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=t@example.com',
      ...args,
    ]);
  git('init', '-q', '-b', 'main');
  writeFileSync(join(cwd, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  writeFileSync(join(cwd, 'a.txt'), 'two\n');

  const project = join(root, 'config', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(project, { recursive: true });
  transcript = join(project, `${sessionId}.jsonl`);
  writeFileSync(transcript, line('u1', 'Fix the login loop'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function line(uuid: string, text: string): string {
  return `${JSON.stringify({ type: 'user', uuid, timestamp: '2026-10-18T10:00:00.000Z', message: { content: text } })}\n`;
}

function sync(extra: Record<string, unknown> = {}): Promise<void> {
  const child = spawn(process.execPath, [hookScript], {
    env: {
      ...process.env,
      // Nothing real: no credentials, no GitHub stamp, no `gh` read.
      HOME: root,
      JOC_GITHUB: '0',
      JOC_URL: serverUrl,
      CLAUDE_CONFIG_DIR: join(root, 'config'),
      CLAUDE_PLUGIN_DATA: join(root, 'data'),
    },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  child.stdin.end(
    JSON.stringify({ hook_event_name: 'Sync', session_id: sessionId, cwd, ...extra }),
  );
  return new Promise((resolve) => child.on('exit', () => resolve()));
}

const paths = () => received.map((r) => r.path);
const texts = (body: Record<string, unknown> | undefined) =>
  ((body?.items ?? []) as { text: string }[]).map((i) => i.text);

test('a sync reports without a state, and sends the backlog and the diff', async () => {
  await sync();
  assert.deepEqual(paths(), ['/api/reports', '/api/messages', '/api/changes']);
  const [report, messages, changes] = received.map((r) => r.body);
  assert.equal(report?.sessionId, sessionId);
  assert.equal(report?.repo, 'atlas-web');
  assert.equal(report?.branch, 'main');
  assert.equal('state' in (report ?? {}), false);
  assert.equal('activity' in (report ?? {}), false);
  assert.deepEqual(texts(messages), ['Fix the login loop']);
  assert.match(String(changes?.diff), /\+two/);
});

test('every request names the plugin version from its manifest', async () => {
  const manifest = join(import.meta.dirname, '..', '.claude-plugin', 'plugin.json');
  const { version } = JSON.parse(readFileSync(manifest, 'utf8'));
  await sync();
  assert.ok(received.length > 0);
  for (const r of received) assert.equal(r.plugin, version, r.path);
});

test('a sync with nothing new only refreshes the session', async () => {
  await sync();
  received = [];
  await sync();
  assert.deepEqual(paths(), ['/api/reports']);
});

test('a backlog the server refused is sent again on the next sync', async () => {
  messagesStatus = 503;
  await sync();
  // The refusal goes to the problem log, and on to the server since it took the report.
  assert.deepEqual(paths(), ['/api/reports', '/api/messages', '/api/problems']);
  messagesStatus = 200;
  appendFileSync(transcript, line('u2', 'And the logout'));
  received = [];
  await sync();
  const messages = received.find((r) => r.path === '/api/messages')?.body;
  assert.deepEqual(texts(messages), ['Fix the login loop', 'And the logout']);
});

test('a sync sends the diff again once files change outside Claude', async () => {
  await sync();
  writeFileSync(join(cwd, 'b.txt'), 'new\n');
  received = [];
  await sync();
  assert.deepEqual(paths(), ['/api/reports', '/api/changes']);
  assert.match(String(received[1]?.body.diff), /b\.txt/);
});

test('a given transcript path is used as is', async () => {
  const elsewhere = join(root, 'elsewhere.jsonl');
  writeFileSync(elsewhere, line('x1', 'From elsewhere'));
  await sync({ transcript_path: elsewhere });
  const messages = received.find((r) => r.path === '/api/messages')?.body;
  assert.deepEqual(texts(messages), ['From elsewhere']);
});

test('findTranscript looks in the project folder, then searches the others', () => {
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config');
  try {
    assert.equal(findTranscript(sessionId, cwd), transcript);
    assert.equal(findTranscript(sessionId, '/somewhere/else'), transcript);
    assert.equal(findTranscript('unknown-session', cwd), undefined);
    assert.equal(findTranscript('../escape', cwd), undefined);
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
  }
});

/** A user message with a pasted image: a tiny made-up PNG, base64, as Claude Code keeps it. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x68, 0x69]);
function pasted(uuid: string, text: string): string {
  const content = [
    ...(text ? [{ type: 'text', text }] : []),
    {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') },
    },
  ];
  return `${JSON.stringify({ type: 'user', uuid, timestamp: '2026-10-18T10:01:00.000Z', message: { content } })}\n`;
}

const sentItems = () =>
  (received.find((r) => r.path === '/api/messages')?.body.items ?? []) as {
    id: string;
    text: string;
    images?: unknown[];
  }[];

test('a pasted image is uploaded as its bytes before the message that shows it', async () => {
  appendFileSync(transcript, pasted('u2', 'Why is this red?'));
  await sync();
  assert.deepEqual(paths(), ['/api/reports', '/api/images', '/api/messages', '/api/changes']);
  const upload = received[1]?.body;
  assert.equal(upload?.type, 'image/png');
  assert.equal(upload?.bytes, PNG.toString('latin1'));
  assert.deepEqual(sentItems().at(-1), {
    id: 'u2:0',
    at: '2026-10-18T10:01:00.000Z',
    kind: 'user',
    text: 'Why is this red?',
    images: [{ id: IMAGE_ID, type: 'image/png', bytes: PNG.length }],
  });
});

test('an image the server refuses is left out, and a message of only that is dropped', async () => {
  imagesStatus = 415;
  appendFileSync(transcript, pasted('u2', 'Kept text'));
  appendFileSync(transcript, pasted('u3', ''));
  await sync();
  assert.deepEqual(
    sentItems().map((i) => [i.id, i.text, i.images]),
    [
      ['u1', 'Fix the login loop', undefined],
      ['u2:0', 'Kept text', undefined],
    ],
  );
});

test('an image the server could not take now holds the messages for the next sync', async () => {
  imagesStatus = 503;
  appendFileSync(transcript, pasted('u2', 'Later'));
  await sync();
  // The 503 is a problem for the Machines page, sent because the report got through.
  assert.deepEqual(paths(), ['/api/reports', '/api/images', '/api/problems']);
  imagesStatus = 201;
  received = [];
  await sync();
  assert.deepEqual(
    sentItems().map((i) => i.id),
    ['u1', 'u2:0'],
  );
});

// A turn that ended with a background shell running, as Claude Code's Stop hook says it.
const stop = {
  hook_event_name: 'Stop',
  last_assistant_message: 'Started the atlas-web dev server.',
  background_tasks: [{ id: 'bk3d9q2x1', type: 'shell', status: 'running', command: 'pnpm dev' }],
};
const stopped = (id: string) =>
  `${JSON.stringify({
    type: 'user',
    uuid: `stop-${id}`,
    timestamp: '2026-10-18T10:05:00.000Z',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: '{}' }] },
    toolUseResult: { message: `Successfully stopped task: ${id} (pnpm dev)`, task_id: id },
  })}\n`;
const reports = () => received.filter((r) => r.path === '/api/reports').map((r) => r.body);

test('between turns, a sync settles a session whose background work ended as idle', async () => {
  await sync(stop);
  assert.equal(reports()[0]?.state, 'background');
  appendFileSync(transcript, stopped('bk3d9q2x1'));
  received = [];
  const checkedAt = Date.now();
  await sync({ between_turns: true, checked_at: checkedAt });
  const [report] = reports();
  assert.equal(report?.state, 'idle');
  assert.equal(report?.activity, 'Done');
  assert.deepEqual(report?.background, []);
  // It counts from when register.ts looked, so a turn that started since wins at the server.
  assert.equal(report?.at, checkedAt);
  // Settled once: the next sync has nothing to change.
  received = [];
  await sync({ between_turns: true });
  assert.equal('state' in (reports()[0] ?? {}), false);
});

test('a sync leaves the state alone mid-turn, or while the work still runs', async () => {
  await sync(stop);
  received = [];
  await sync({ between_turns: true });
  assert.equal('state' in (reports()[0] ?? {}), false);
  appendFileSync(transcript, stopped('bk3d9q2x1'));
  received = [];
  await sync({ between_turns: false });
  await sync();
  assert.deepEqual(
    reports().map((r) => 'state' in r),
    [false, false],
  );
});

test('a sync never settles a working session', async () => {
  await sync(stop);
  await sync({ hook_event_name: 'UserPromptSubmit', prompt: 'Now the docs' });
  appendFileSync(transcript, stopped('bk3d9q2x1'));
  received = [];
  await sync({ between_turns: true });
  assert.equal('state' in (reports()[0] ?? {}), false);
});

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
let received: { path: string; body: Record<string, unknown> }[];
let messagesStatus: number;

before(async () => {
  server = createServer((req, res) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      received.push({ path: req.url ?? '', body: JSON.parse(data) });
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

test('a sync with nothing new only refreshes the session', async () => {
  await sync();
  received = [];
  await sync();
  assert.deepEqual(paths(), ['/api/reports']);
});

test('a backlog the server refused is sent again on the next sync', async () => {
  messagesStatus = 503;
  await sync();
  assert.deepEqual(paths(), ['/api/reports', '/api/messages']);
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

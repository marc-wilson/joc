import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { PluginProblem, ProblemsReport } from '@joc/protocol';
import {
  applyOutcomes,
  describeProblem,
  errorDetail,
  exitDetail,
  markSent,
  type Outcome,
  type PluginStatus,
  parseStatus,
  responseOutcome,
  toSend,
} from './problems.ts';

const SERVER = 'https://joc.example';
const empty: PluginStatus = { problems: [] };

const unreachable = (at: number): Outcome => ({
  ok: false,
  kind: 'unreachable',
  where: SERVER,
  detail: 'TypeError: fetch failed (connect ECONNREFUSED)',
  at,
});
const ok = (where: string, at: number): Outcome => ({ ok: true, where, at });

// ── The log's rules ──────────────────────────────────────────────────────────

test('the same problem counts up, and starts a new run once it cleared', () => {
  let status = applyOutcomes(empty, [unreachable(1000), unreachable(2000), unreachable(3000)]);
  assert.equal(status.problems.length, 1);
  assert.deepEqual(
    [status.problems[0]?.firstAt, status.problems[0]?.lastAt, status.problems[0]?.count],
    [1000, 3000, 3],
  );

  status = applyOutcomes(status, [ok('/api/reports', 4000)]);
  assert.equal(status.problems[0]?.resolvedAt, 4000);
  assert.equal(status.lastOkAt, 4000);

  status = applyOutcomes(status, [unreachable(5000)]);
  assert.deepEqual(
    [status.problems[0]?.firstAt, status.problems[0]?.count, status.problems[0]?.resolvedAt],
    [5000, 1, undefined],
  );
});

test('a refused request clears only when that request works, not when another one does', () => {
  const refused = responseOutcome(
    { status: 400, body: '{"error":[]}' },
    '/api/messages',
    SERVER,
    1000,
  );
  let status = applyOutcomes(empty, [refused, ok('/api/reports', 2000)]);
  assert.equal(status.problems[0]?.resolvedAt, undefined);
  status = applyOutcomes(status, [ok('/api/messages', 3000)]);
  assert.equal(status.problems[0]?.resolvedAt, 3000);
});

test('the log keeps the newest 20 problems', () => {
  const outcomes = Array.from(
    { length: 25 },
    (_, i): Outcome => ({
      ok: false,
      kind: 'rejected',
      where: `/api/path-${i}`,
      detail: 'HTTP 404',
      at: 1000 + i,
    }),
  );
  const { problems } = applyOutcomes(empty, outcomes);
  assert.equal(problems.length, 20);
  assert.equal(problems[0]?.where, '/api/path-5');
  assert.equal(problems.at(-1)?.where, '/api/path-24');
});

test('lastOkAt is only rewritten once a minute, so a busy session is not a write per hook', () => {
  const first = applyOutcomes(empty, [ok('/api/reports', 1000)]);
  assert.equal(first.lastOkAt, 1000);
  assert.equal(applyOutcomes(first, [ok('/api/reports', 30_000)]).lastOkAt, 1000);
  assert.equal(applyOutcomes(first, [ok('/api/reports', 61_000)]).lastOkAt, 61_000);
  // The hook's own clean run says nothing about the server.
  assert.equal(applyOutcomes(empty, [ok('hook', 1000)]).lastOkAt, undefined);
});

test('responses are sorted into kinds, with what the server said', () => {
  const issues = JSON.stringify({
    error: [{ path: ['items', 0, 'text'], message: 'Invalid input: expected string' }],
  });
  assert.deepEqual(responseOutcome({ status: 202, body: '' }, '/api/reports', SERVER, 1), {
    ok: true,
    where: '/api/reports',
    at: 1,
  });
  assert.deepEqual(responseOutcome({ status: 400, body: issues }, '/api/messages', SERVER, 1), {
    ok: false,
    kind: 'rejected',
    where: '/api/messages',
    detail: 'HTTP 400: items.0.text: Invalid input: expected string',
    at: 1,
  });
  const unauthorized = responseOutcome(
    { status: 401, body: '{"error":"Unauthorized"}' },
    '/api/reports',
    SERVER,
    1,
  );
  assert.deepEqual(unauthorized.ok ? undefined : [unauthorized.kind, unauthorized.where], [
    'unauthorized',
    SERVER,
  ]);
  const failed = responseOutcome({ status: 502, body: '<html>' }, '/api/changes', SERVER, 1);
  assert.deepEqual(failed.ok ? undefined : [failed.kind, failed.detail], [
    'server-error',
    'HTTP 502',
  ]);
});

test('errors become one line naming the plugin file, never a home path', () => {
  const error = new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') });
  error.stack = `TypeError: fetch failed\n    at post (file:///home/someone/.claude/plugins/joc/src/hook.ts:61:28)`;
  assert.equal(errorDetail(error), 'TypeError: fetch failed (connect ECONNREFUSED) at hook.ts:61');
  assert.equal(errorDetail('plain'), 'plain');
  const stderr = [
    'file:///home/someone/.claude/plugins/joc/src/hook.ts:12',
    'const x = ;',
    '          ^',
    '',
    "SyntaxError: Unexpected token ';'",
    '    at compileSourceTextModule (node:internal/modules/esm/utils:318:16)',
  ].join('\n');
  assert.equal(exitDetail(1, stderr), "SyntaxError: Unexpected token ';' at hook.ts:12");
  assert.equal(exitDetail(9, ''), 'node exited with code 9');
});

test('a missing or broken log reads as empty, and junk entries are dropped', () => {
  assert.deepEqual(parseStatus(undefined), empty);
  assert.deepEqual(parseStatus('{"problems": ['), empty);
  const good = applyOutcomes(empty, [unreachable(1000)]).problems[0];
  assert.deepEqual(
    parseStatus(JSON.stringify({ lastOkAt: 5, problems: [good, { kind: 'nope' }, 'x'] })),
    { lastOkAt: 5, problems: [good] },
  );
});

test('problems go to the server once a minute, each version once', () => {
  const status = applyOutcomes(empty, [
    unreachable(1000),
    ok('/api/reports', 2000),
    { ok: false, kind: 'rejected', where: '/api/problems', detail: 'HTTP 400', at: 2500 },
  ]);
  const sending = toSend(status, 100_000);
  // Never the problem about sending problems: it would fail the same way.
  assert.deepEqual(
    sending.map((p) => p.where),
    [SERVER],
  );
  assert.ok(sending.every((p) => PluginProblem.safeParse(p).success));
  assert.ok(ProblemsReport.safeParse({ machine: 'atlas-laptop', problems: sending }).success);

  const sent = markSent(status, sending, 100_000);
  assert.deepEqual(toSend(sent, 100_000 + 61_000), []);
  assert.deepEqual(toSend(applyOutcomes(sent, [unreachable(110_000)]), 130_000), []);
  assert.equal(toSend(applyOutcomes(sent, [unreachable(110_000)]), 161_000).length, 1);
});

test('the status text says what, how often and whether it stopped', () => {
  const [problem] = applyOutcomes(empty, [
    unreachable(0),
    unreachable(5 * 60_000),
    ok('/api/reports', 6 * 60_000),
  ]).problems;
  assert.ok(problem);
  assert.equal(
    describeProblem(problem, 8 * 60_000),
    [
      `  3m ago  Couldn't reach ${SERVER}, 2 times over 5m, worked again 2m ago`,
      '      TypeError: fetch failed (connect ECONNREFUSED)',
    ].join('\n'),
  );
});

// ── hook.ts, run as Claude Code runs it, against a stand-in server ──────────

const hookScript = join(import.meta.dirname, 'hook.ts');

let root: string;
let cwd: string;
let server: Server;
let serverUrl: string;
let received: { path: string; body: unknown }[];
/** The status and body the stand-in answers each path with; 200 `{}` otherwise. */
let answers: Map<string, { status: number; body: string }>;

before(async () => {
  server = createServer((req, res) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      received.push({ path: req.url ?? '', body: JSON.parse(data) });
      const answer = answers.get(req.url ?? '') ?? { status: 200, body: '{}' };
      res.statusCode = answer.status;
      res.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  serverUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

after(() => server.close());

beforeEach(() => {
  received = [];
  answers = new Map();
  root = mkdtempSync(join(tmpdir(), 'joc-problems-test-'));
  cwd = join(root, 'atlas-web');
  mkdirSync(cwd);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Runs hook.ts once; resolves with its exit code and anything it printed. */
function runHook(stdin: string, url = serverUrl): Promise<{ code: number | null; output: string }> {
  const child = spawn(process.execPath, [hookScript], {
    env: {
      ...process.env,
      // Nothing real: no credentials, no GitHub stamp, no `gh` read, no real problem log.
      HOME: root,
      JOC_GITHUB: '0',
      JOC_URL: url,
      CLAUDE_CONFIG_DIR: join(root, 'config'),
      CLAUDE_PLUGIN_DATA: join(root, 'data'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  child.stdin.end(stdin);
  return new Promise((resolve) => child.on('exit', (code) => resolve({ code, output })));
}

const prompt = () =>
  runHook(
    JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'problems-test-session',
      cwd,
      prompt: 'Fix the login loop',
    }),
  );

const log = (): PluginStatus =>
  parseStatus(readFileSync(join(root, '.claude', 'joc', 'status.json'), 'utf8'));
const paths = () => received.map((r) => r.path);

test('an unreachable server is logged, not shown, and the hook still exits 0', async () => {
  // A port nothing listens on.
  const closed = 'http://127.0.0.1:9';
  for (let i = 0; i < 2; i++) {
    const run = await runHook(
      JSON.stringify({ hook_event_name: 'Stop', session_id: 's', cwd }),
      closed,
    );
    assert.deepEqual(run, { code: 0, output: '' });
  }
  const [problem] = log().problems;
  assert.equal(problem?.kind, 'unreachable');
  assert.equal(problem?.where, closed);
  assert.equal(problem?.count, 2);
  assert.match(problem?.detail ?? '', /fetch failed/);
});

test('a refused token is logged, and nothing is sent to a server that refuses it', async () => {
  answers.set('/api/reports', { status: 401, body: '{"error":"Unauthorized"}' });
  assert.deepEqual(await prompt(), { code: 0, output: '' });
  assert.deepEqual(paths(), ['/api/reports']);
  const [problem] = log().problems;
  assert.deepEqual([problem?.kind, problem?.where], ['unauthorized', serverUrl]);
});

test('a refused report is logged with why, and sent once while the server takes others', async () => {
  answers.set('/api/reports', {
    status: 400,
    body: JSON.stringify({ error: [{ path: ['repo'], message: 'Too small' }] }),
  });
  const config = join(root, 'config', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(config, { recursive: true });
  const transcript = join(config, 'problems-test-session.jsonl');
  writeFileSync(
    transcript,
    `${JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-10-18T10:00:00.000Z', message: { content: 'Fix it' } })}\n`,
  );
  const run = () =>
    runHook(
      JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'problems-test-session',
        cwd,
        prompt: 'Fix it',
        transcript_path: transcript,
      }),
    );
  await run();
  assert.deepEqual(paths(), ['/api/reports', '/api/messages', '/api/problems']);
  const report = ProblemsReport.parse(received[2]?.body);
  assert.deepEqual(
    report.problems.map((p) => [p.kind, p.where, p.detail]),
    [['rejected', '/api/reports', 'HTTP 400: repo: Too small']],
  );
  assert.equal(log().problems[0]?.sent, true);

  // Again within the minute: counted locally, not sent again yet.
  received = [];
  await run();
  assert.deepEqual(paths(), ['/api/reports']);
  assert.equal(log().problems[0]?.count, 2);
  assert.equal(log().problems[0]?.sent, undefined);
});

test('a crash in the hook is logged, and cleared by the next clean run', async () => {
  assert.deepEqual(await runHook('not json'), { code: 0, output: '' });
  const [crash] = log().problems;
  assert.deepEqual([crash?.kind, crash?.where], ['crash', 'hook']);
  assert.match(crash?.detail ?? '', /^SyntaxError: .* at hook\.ts:\d+$/);

  await prompt();
  assert.ok(log().problems[0]?.resolvedAt);
  // Sent along with the clean run's report, already marked as over.
  const report = ProblemsReport.parse(received.find((r) => r.path === '/api/problems')?.body);
  assert.deepEqual(
    report.problems.map((p) => [p.kind, !!p.resolvedAt]),
    [['crash', true]],
  );
});

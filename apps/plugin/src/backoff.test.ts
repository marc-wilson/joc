import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { afterOutcome, holdsOff, MAX_WAIT_MS, NOT_WAITING } from './backoff.ts';
import type { Outcome } from './problems.ts';

const SERVER = 'https://joc.example';
const down = (at: number): Outcome => ({
  ok: false,
  kind: 'server-error',
  where: '/api/deletes/claim',
  detail: 'HTTP 503',
  at,
});
const unreachable = (at: number): Outcome => ({
  ok: false,
  kind: 'unreachable',
  where: SERVER,
  detail: 'TypeError: fetch failed',
  at,
});

test('one failure holds nothing off, so a blip costs no poll', () => {
  assert.equal(holdsOff(afterOutcome(NOT_WAITING, down(1000)), 1000), false);
});

test('the wait grows with how long the server has been down, up to the most', () => {
  const start = 1_000_000;
  const at = (seconds: number) => start + seconds * 1000;
  let backoff = afterOutcome(NOT_WAITING, down(at(0)));
  backoff = afterOutcome(backoff, down(at(2)));
  assert.equal(backoff.until, at(4));
  backoff = afterOutcome(backoff, down(at(4)));
  assert.equal(backoff.until, at(8));
  backoff = afterOutcome(backoff, unreachable(at(3600)));
  assert.equal(backoff.until, at(3600) + MAX_WAIT_MS);
});

test('polls reporting at the same moment do not speed the backoff up', () => {
  const once = afterOutcome(afterOutcome(NOT_WAITING, down(1000)), down(3000));
  assert.deepEqual(afterOutcome(once, unreachable(3000)), once);
});

test('any answer from the server ends the wait', () => {
  const backoff = afterOutcome(afterOutcome(NOT_WAITING, down(1000)), down(9000));
  const answers: Outcome[] = [
    { ok: true, where: '/api/resumes/claim', at: 9500 },
    { ok: false, kind: 'rejected', where: '/api/commands', detail: 'HTTP 400', at: 9500 },
    { ok: false, kind: 'unauthorized', where: SERVER, detail: 'HTTP 401', at: 9500 },
  ];
  for (const answer of answers) assert.deepEqual(afterOutcome(backoff, answer), NOT_WAITING);
});

test('what says nothing about the server leaves the wait alone', () => {
  const backoff = afterOutcome(afterOutcome(NOT_WAITING, down(1000)), down(9000));
  const silent: Outcome[] = [
    { ok: true, where: 'module', at: 9500 },
    { ok: false, kind: 'crash', where: 'module', detail: 'Error: boom', at: 9500 },
  ];
  for (const outcome of silent) assert.deepEqual(afterOutcome(backoff, outcome), backoff);
});

// The module as Claude Code runs it, on a fake clock, against a server that's down or not.
// Loaded by URL: tsc leaves register.ts out, as its 'claude-code' types come from the engine.
type Handler = (
  engine: object,
  event: { isInteractive: boolean },
  next: () => Promise<object>,
) => Promise<object>;
type Register = (on: (event: string, handler: Handler) => void) => void;
const { register }: { register: Register } = await import(
  new URL('./register.ts', import.meta.url).href
);
const START = 1_000_000_000;

/** A session on a fake engine, with its polls and the requests they made. */
async function session(answer: () => { status: number; text: string }) {
  const polls: { ms: number; run: () => void }[] = [];
  const requests: string[] = [];
  const handlers = new Map<string, Handler>();
  const engine = {
    clock: {
      every: (ms: number, run: () => void) => polls.push({ ms, run }),
      after: () => undefined,
      sleep: () => new Promise(() => {}),
    },
    command: { register: async () => undefined },
    env: { get: async (name: string) => (name === 'JOC_URL' ? SERVER : undefined) },
    fs: { exists: async () => false, read: async () => '{}', write: async () => undefined },
    http: {
      fetch: async (url: string) => {
        requests.push(url);
        const { status, text } = answer();
        return { ok: status < 400, status, text, headers: {} };
      },
    },
    plugin: { name: 'joc', root: '/plugins/joc' },
    process: { run: async () => ({ exitCode: 0, stdout: 'atlas-mac\n', stderr: '' }) },
    session: { cwd: async () => '/work', id: async () => 'backoff-test-session' },
    ui: { toast: () => undefined },
  };
  register((event, handler) => handlers.set(event, handler));
  const start = handlers.get('session.start');
  assert.ok(start);
  await start(engine, { isInteractive: true }, async () => ({}));

  /** Runs the fake clock on by whole seconds, each poll firing on its own pace. */
  async function run(seconds: number) {
    for (let second = 1; second <= seconds; second++) {
      mock.timers.tick(1000);
      const now = Date.now() - START;
      for (const { ms, run } of polls) if (now % ms === 0) run();
      // Lets each poll's awaits finish before the next second, as a real second would.
      for (let i = 0; i < 40; i++) await Promise.resolve();
    }
  }
  return { requests, run };
}

beforeEach(() => mock.timers.enable({ apis: ['Date'], now: START }));
afterEach(() => mock.timers.reset());

const OK = { status: 200, text: '{}' };
const UNAVAILABLE = { status: 503, text: '<html>nginx</html>' };

test('a session keeps its pace while the server answers', async () => {
  const { requests, run } = await session(() => OK);
  await run(60);
  // Prompts every 2s, launches and resumes every 5s, deletes every 10s.
  assert.equal(requests.length, 30 + 12 + 12 + 6);
});

test('an hour down costs a session about one request a minute, and a recovery shows in time', async () => {
  let answer = UNAVAILABLE;
  const { requests, run } = await session(() => answer);
  await run(3600);
  // Without backoff this hour is 3,600 requests.
  assert.ok(requests.length <= 90, `${requests.length} requests`);
  answer = OK;
  // The first attempt after the wait hears the server, and every poll is back to its pace.
  await run(MAX_WAIT_MS / 1000);
  const recovered = requests.length;
  await run(60);
  assert.equal(requests.length - recovered, 60);
});

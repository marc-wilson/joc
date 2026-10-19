import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
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
import type { GitHubNotification } from '@joc/protocol';
import {
  type ApiThread,
  newAlerts,
  notificationsDue,
  parseIncluded,
  toNotification,
} from './notifications.ts';

const api = 'https://api.github.com/repos/harbor-labs/atlas-web';
const thread = (
  extra: Partial<ApiThread> & { subject?: ApiThread['subject'] } = {},
): ApiThread => ({
  id: '5001',
  reason: 'review_requested',
  updated_at: '2026-10-18T10:00:00Z',
  subject: { title: 'Fix the login loop', url: `${api}/pulls/42`, type: 'PullRequest' },
  repository: {
    full_name: 'harbor-labs/atlas-web',
    html_url: 'https://github.com/harbor-labs/atlas-web',
  },
  ...extra,
});

test('a thread links to its page on github.com', () => {
  const page = (url: string | null, type: string) =>
    toNotification(thread({ subject: { title: 'x', url, type } }))?.url;
  const repo = 'https://github.com/harbor-labs/atlas-web';
  assert.equal(page(`${api}/pulls/42`, 'PullRequest'), `${repo}/pull/42`);
  assert.equal(page(`${api}/issues/7`, 'Issue'), `${repo}/issues/7`);
  assert.equal(page(`${api}/commits/abc1234`, 'Commit'), `${repo}/commit/abc1234`);
  assert.equal(page(`${api}/discussions/3`, 'Discussion'), `${repo}/discussions/3`);
  assert.equal(page(`${api}/releases/991`, 'Release'), `${repo}/releases`);
  assert.equal(page(null, 'CheckSuite'), `${repo}/actions`);
  assert.equal(page(null, 'RepositoryInvitation'), repo);
});

test('a thread keeps its fields, and only the few that need you raise an alert', () => {
  const pr = toNotification(thread());
  assert.deepEqual(
    [pr?.id, pr?.reason, pr?.type, pr?.repo, pr?.number, pr?.updatedAt, pr?.alert],
    [
      '5001',
      'review_requested',
      'PullRequest',
      'harbor-labs/atlas-web',
      42,
      '2026-10-18T10:00:00.000Z',
      'review',
    ],
  );
  const alert = (reason: string, title = 'x', type = 'Issue') =>
    toNotification(thread({ reason, subject: { title, url: null, type } }))?.alert;
  assert.equal(alert('mention'), 'mention');
  assert.equal(alert('team_mention'), 'mention');
  assert.equal(alert('comment'), undefined);
  assert.equal(alert('subscribed'), undefined);
  assert.equal(
    alert('ci_activity', 'CI workflow run failed for main branch', 'CheckSuite'),
    'ci-failed',
  );
  assert.equal(
    alert('ci_activity', 'CI workflow run succeeded for main branch', 'CheckSuite'),
    undefined,
  );
  const ci = toNotification(
    thread({
      reason: 'ci_activity',
      subject: {
        title: 'Build workflow run failed for fix/login-loop branch',
        url: null,
        type: 'CheckSuite',
      },
    }),
  );
  assert.equal(ci?.branch, 'fix/login-loop');
  assert.equal(toNotification({}), undefined);
  assert.equal(toNotification(thread({ id: '../1' })), undefined);
});

test("gh's included headers are read, 304 and all", () => {
  const ok = parseIncluded(
    'HTTP/2.0 200 OK\r\nLast-Modified: Sun, 18 Oct 2026 10:00:00 GMT\r\nX-Poll-Interval: 120\r\n\r\n[]',
  );
  assert.deepEqual(
    [ok?.status, ok?.headers.get('last-modified'), ok?.headers.get('x-poll-interval'), ok?.body],
    [200, 'Sun, 18 Oct 2026 10:00:00 GMT', '120', '[]'],
  );
  assert.equal(parseIncluded('HTTP/2.0 304 Not Modified\n\n')?.status, 304);
  assert.equal(parseIncluded('gh: not logged in'), undefined);
});

test('the feed is read at most as often as GitHub asks, and never under a minute', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'joc-notif-')), 'stamp.json');
  assert.ok(notificationsDue(1_000_000, file));
  assert.equal(notificationsDue(1_030_000, file), undefined);
  assert.ok(notificationsDue(1_061_000, file));
  writeFileSync(file, JSON.stringify({ at: 2_000_000, intervalS: 300 }));
  assert.equal(notificationsDue(2_200_000, file), undefined);
  assert.ok(notificationsDue(2_300_000, file));
  writeFileSync(file, JSON.stringify({ at: 3_000_000, intervalS: 5 }));
  assert.equal(notificationsDue(3_030_000, file), undefined);
});

test('an alert notifies once, and the first read only remembers what was waiting', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'joc-notif-')), 'notified.json');
  const n = (id: string, alert?: GitHubNotification['alert']): GitHubNotification => {
    const t = toNotification(thread({ id }));
    assert.ok(t);
    return { ...t, alert };
  };
  assert.deepEqual(newAlerts([n('1', 'review'), n('2')], 1, file), []);
  assert.deepEqual(
    newAlerts([n('1', 'review'), n('3', 'mention'), n('4')], 2, file).map((t) => t.id),
    ['3'],
  );
  assert.deepEqual(newAlerts([n('1', 'review'), n('3', 'mention')], 3, file), []);
  // A new reason on a known thread is news of its own.
  assert.deepEqual(
    newAlerts([n('1', 'mention')], 4, file).map((t) => t.id),
    ['1'],
  );
});

// The whole turn, as register.ts runs it: hook.ts on a Sync, with a stand-in `gh` and server.

const hookScript = join(import.meta.dirname, 'hook.ts');
let root: string;
let server: Server;
let serverUrl: string;
let received: { path: string; body: Record<string, unknown> }[];
let claimIds: string[];

before(async () => {
  server = createServer((req, res) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      received.push({ path: req.url ?? '', body: JSON.parse(data || '{}') });
      res.setHeader('content-type', 'application/json');
      res.end(
        req.url === '/api/notifications/reads/claim' ? JSON.stringify({ ids: claimIds }) : '{}',
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  serverUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

after(() => server.close());

// Answers like `gh api`: the feed from feed.json, a 304 when asked If-Modified-Since and
// unchanged.json exists, and every call logged to calls.jsonl.
const FAKE_GH = `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const dir = process.env.FAKE_GH_DIR;
const args = process.argv.slice(2);
appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify(args) + '\\n');
if (args[1] === 'graphql') { process.stdout.write('{}'); process.exit(0); }
if (args.includes('PATCH')) process.exit(0);
if (args.some((a) => a.startsWith('If-Modified-Since:')) && existsSync(join(dir, 'unchanged.json'))) {
  process.stdout.write('HTTP/2.0 304 Not Modified\\r\\nX-Poll-Interval: 60\\r\\n\\r\\n');
  process.exit(1);
}
process.stdout.write('HTTP/2.0 200 OK\\r\\nLast-Modified: Sun, 18 Oct 2026 10:00:00 GMT\\r\\nX-Poll-Interval: 60\\r\\n\\r\\n');
process.stdout.write(readFileSync(join(dir, 'feed.json'), 'utf8'));
`;

beforeEach(() => {
  received = [];
  claimIds = [];
  root = mkdtempSync(join(tmpdir(), 'joc-notif-sync-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  chmodSync(join(bin, 'gh'), 0o755);
  mkdirSync(join(root, 'cwd'));
  feed([thread()]);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const feed = (threads: ApiThread[]) =>
  writeFileSync(join(root, 'feed.json'), JSON.stringify(threads));
const calls = (): string[][] =>
  existsSync(join(root, 'calls.jsonl'))
    ? readFileSync(join(root, 'calls.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
    : [];
const stampFile = () => join(root, '.claude', 'joc', 'notifications-read.json');
/** Makes the next read due, as if a minute had passed. */
const later = () => {
  const stamp = JSON.parse(readFileSync(stampFile(), 'utf8'));
  writeFileSync(stampFile(), JSON.stringify({ ...stamp, at: 0 }));
};

async function sync(extra: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [hookScript], {
    env: {
      ...process.env,
      HOME: root,
      PATH: `${join(root, 'bin')}:${process.env.PATH}`,
      FAKE_GH_DIR: root,
      JOC_GITHUB: '1',
      JOC_NOTIFY: '1',
      JOC_URL: serverUrl,
      JOC_TOKEN: '',
      CLAUDE_CONFIG_DIR: join(root, 'config'),
      CLAUDE_PLUGIN_DATA: join(root, 'data'),
      ...env,
    },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let out = '';
  child.stdout.on('data', (chunk) => {
    out += chunk;
  });
  child.stdin.end(
    JSON.stringify({
      hook_event_name: 'Sync',
      session_id: 'notif-session',
      cwd: join(root, 'cwd'),
      can_notify: true,
      ...extra,
    }),
  );
  await new Promise((resolve) => child.on('exit', resolve));
  return out;
}

const reported = () => received.filter((r) => r.path === '/api/notifications').map((r) => r.body);

test('a sync marks read what the dashboard asked, then reports the feed', async () => {
  claimIds = ['4999', 'not-a-thread'];
  assert.equal(await sync(), '');
  assert.deepEqual(
    calls().filter((c) => c.includes('PATCH')),
    [['api', '-X', 'PATCH', '/notifications/threads/4999']],
  );
  // Having just marked one read, it reads the whole feed rather than asking what changed.
  const read = calls().find((c) => c.includes('-i'));
  assert.equal(
    read?.some((a) => a.startsWith('If-Modified-Since')),
    false,
  );
  const [report] = reported();
  assert.equal(report?.status, 'ok');
  assert.match(
    JSON.stringify(report?.threads),
    /"url":"https:\/\/github\.com\/harbor-labs\/atlas-web\/pull\/42"/,
  );
});

test('only news notifies, once, and an unchanged feed costs a 304', async () => {
  await sync();
  later();
  feed([
    thread(),
    thread({
      id: '5002',
      reason: 'mention',
      subject: { title: 'Can you check this', url: `${api}/issues/9`, type: 'Issue' },
    }),
  ]);
  const out = await sync();
  assert.deepEqual(JSON.parse(out), {
    notify: [
      { title: 'JOC: You were mentioned', text: 'harbor-labs/atlas-web#9 Can you check this' },
    ],
  });
  assert.ok(calls().at(-1)?.includes('If-Modified-Since: Sun, 18 Oct 2026 10:00:00 GMT'));

  later();
  writeFileSync(join(root, 'unchanged.json'), '');
  received = [];
  assert.equal(await sync(), '');
  assert.deepEqual(reported(), []);
});

test('not due, JOC_NOTIFY=0 and a session without a terminal print nothing', async () => {
  await sync();
  feed([thread(), thread({ id: '5003', reason: 'review_requested' })]);
  assert.equal(await sync(), '', 'not due yet');
  later();
  assert.equal(await sync({}, { JOC_NOTIFY: '0' }), '');
  later();
  feed([thread(), thread({ id: '5004', reason: 'review_requested' })]);
  assert.equal(await sync({ can_notify: false }), '');
  // It left 5004 for a session that can notify, and made that read a full one.
  later();
  writeFileSync(join(root, 'unchanged.json'), '');
  assert.match(await sync(), /5004|JOC: Review requested/);
});

test('JOC_GITHUB=0 never runs gh', async () => {
  await sync({}, { JOC_GITHUB: '0' });
  assert.deepEqual(calls(), []);
  assert.deepEqual(reported(), []);
});

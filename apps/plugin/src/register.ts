// Delivers prompts typed in the JOC dashboard into this session, keeps the server in sync with
// it between hooks, and links the machine to a JOC account with `/joc-login`. Reporting the
// session's state and conversation is done by the command hooks in hooks.json (src/hook.ts).
// Every SYNC_MS this module runs hook.ts with a `Sync` event, so a session shows up without
// activity (e.g. open before the plugin loaded), a backlog the server missed while down gets
// sent, and the diff refreshes when files change outside Claude.
import type { EngineInterface, Register } from 'claude-code';

const POLL_MS = 2000;
const SYNC_MS = 30_000;
const SYNC_TIMEOUT_MS = 60_000;
const DEFAULT_SERVER = 'https://joc.marcswilson.com';
/** Under the home folder; src/credentials.ts reads the same file for the command hooks. */
const CREDENTIALS = '.claude/joc/credentials.json';

interface Credentials {
  url: string;
  token: string;
}

/**
 * The folder Claude Code gives the plugin's command hooks as CLAUDE_PLUGIN_DATA, where hook.ts
 * keeps its read positions. Not on `$`, so it's worked out from where an installed plugin lives:
 * `<config>/plugins/cache/<marketplace>/<plugin>/<version>` keeps its data in
 * `<config>/plugins/data/<plugin>-<marketplace>`.
 */
function pluginData(root: string): string | undefined {
  const installed = root.match(/^(.*)\/plugins\/cache\/([^/]+)\/([^/]+)\/[^/]+$/);
  if (!installed) return undefined;
  const [, config, marketplace, plugin] = installed;
  return `${config}/plugins/data/${`${plugin}@${marketplace}`.replace(/[^\w-]/g, '-')}`;
}

/** Runs `task` unless its last run is still going; never throws. */
function oneAtATime(task: () => Promise<unknown>): () => void {
  let busy = false;
  return () => {
    if (busy) return;
    busy = true;
    task()
      .catch(() => {}) // The server being down must never bother the session.
      .finally(() => {
        busy = false;
      });
  };
}

/** A parsed JSON body's field, or undefined. The module has no zod: it's dependency-free. */
function field(body: unknown, key: string): unknown {
  if (!body || typeof body !== 'object') return undefined;
  return Object.entries(body).find(([k]) => k === key)?.[1];
}

const text = (value: unknown) => (typeof value === 'string' ? value : undefined);

async function credentialsPath($: EngineInterface): Promise<string | undefined> {
  const home = await $.env.get('HOME');
  return home ? `${home}/${CREDENTIALS}` : undefined;
}

async function readCredentials($: EngineInterface): Promise<Credentials | undefined> {
  const path = await credentialsPath($);
  if (!path || !(await $.fs.exists(path))) return undefined;
  const body: unknown = JSON.parse(await $.fs.read(path));
  const url = text(field(body, 'url'));
  const token = text(field(body, 'token'));
  return url && token ? { url, token } : undefined;
}

/** Where to report and as whom: JOC_URL/JOC_TOKEN when set, else the link, else local dev. */
async function connection($: EngineInterface) {
  const credentials = await readCredentials($).catch(() => undefined);
  const url = (await $.env.get('JOC_URL')) || credentials?.url || 'http://localhost:3000';
  const token = (await $.env.get('JOC_TOKEN')) || credentials?.token;
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  return { url: url.replace(/\/$/, ''), headers };
}

/** `/joc-login [url]`: links this machine. The person approves the code in a signed-in browser. */
async function login($: EngineInterface, args: string): Promise<string> {
  const url = (args.trim() || (await $.env.get('JOC_URL')) || DEFAULT_SERVER).replace(/\/$/, '');
  if (!/^https:\/\/|^http:\/\/localhost(:\d+)?$/.test(url)) {
    return `JOC: ${url} isn't an https address.`;
  }
  const host = await $.process.run(['hostname', '-s'], { timeoutMs: 5000 }).catch(() => undefined);
  const name = host?.stdout.trim() || 'Claude Code';

  const res = await $.http.fetch(`${url}/api/devices/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) return `JOC: couldn't reach ${url} to link this machine (HTTP ${res.status}).`;
  const start: unknown = JSON.parse(res.text);
  const deviceCode = text(field(start, 'deviceCode'));
  const userCode = text(field(start, 'userCode'));
  const verificationUri = text(field(start, 'verificationUri'));
  const interval = Number(field(start, 'interval')) || 2;
  const expiresIn = Number(field(start, 'expiresIn')) || 600;
  if (!deviceCode || !userCode || !verificationUri) return `JOC: ${url} sent an unexpected reply.`;

  // Poll in the background; the command returns now so the person can go enter the code.
  const deadline = Date.now() + expiresIn * 1000;
  const expired = () => $.ui.toast('JOC: the link code expired. Run /joc-login again.');
  const timer = $.clock.every(
    interval * 1000,
    oneAtATime(async () => {
      if (Date.now() > deadline) {
        timer.cancel();
        expired();
        return;
      }
      const poll = await $.http.fetch(`${url}/api/devices/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceCode }),
      });
      if (!poll.ok) return;
      const body: unknown = JSON.parse(poll.text);
      const status = field(body, 'status');
      if (status === 'expired') {
        timer.cancel();
        expired();
        return;
      }
      const token = text(field(body, 'token'));
      if (status !== 'linked' || !token) return;
      timer.cancel();
      const path = await credentialsPath($);
      if (!path) return;
      await $.fs.write(path, `${JSON.stringify({ url, token }, null, 2)}\n`);
      // Says whose account it is, so a code someone else approved doesn't go unnoticed.
      const account = text(field(body, 'login')) ?? 'your account';
      $.ui.toast(`JOC: this machine now reports to @${account} at ${url}.`, { timeoutMs: 8000 });
    }),
  );

  return [
    `To link this machine to JOC, open ${verificationUri} and enter:`,
    '',
    `    ${userCode}`,
    '',
    `The code expires in ${Math.round(expiresIn / 60)} minutes.`,
  ].join('\n');
}

async function logout($: EngineInterface): Promise<string> {
  const path = await credentialsPath($);
  if (!path || !(await $.fs.exists(path))) return "JOC: this machine isn't linked.";
  // $.fs can't delete; an empty object reads as no link.
  await $.fs.write(path, '{}\n');
  return 'JOC: this machine is unlinked. To revoke its token on the server too, remove it under Machines in the dashboard.';
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const result = await next(e);
    await $.command.register({ name: 'joc-login', description: 'Link this machine to JOC' });
    await $.command.register({ name: 'joc-logout', description: 'Unlink this machine from JOC' });
    const root = $.plugin.root.replace(/\/+$/, '').replace(/\/\.claude-plugin$/, '');

    // Every session, as the command hooks report every session. hook.ts finds the server and
    // token the same way this module does (src/credentials.ts).
    const sync = oneAtATime(async () => {
      // Read each time: a /clear starts a new session id without a new session.start.
      const event = {
        hook_event_name: 'Sync',
        session_id: await $.session.id(),
        cwd: await $.session.cwd(),
      };
      await $.process.run(['node', `${root}/src/hook.ts`], {
        stdin: JSON.stringify(event),
        // An empty value makes hook.ts use its own folder rather than one this process has.
        env: { CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: pluginData(root) ?? '' },
        timeoutMs: SYNC_TIMEOUT_MS,
      });
    });
    $.clock.after(1, sync);
    $.clock.every(SYNC_MS, sync);

    // Nobody reads a -p run's dashboard; only take prompts for sessions a person runs.
    if (!e.isInteractive) return result;

    async function takePrompts() {
      const { url, headers } = await connection($);
      const sessionId = await $.session.id();
      const res = await $.http.fetch(
        `${url}/api/sessions/${encodeURIComponent(sessionId)}/prompts/claim`,
        { method: 'POST', headers },
      );
      if (!res.ok) return;
      const prompts = field(JSON.parse(res.text), 'prompts');
      if (!Array.isArray(prompts)) return;
      // Each starts its own turn once the session is idle, in the order they were sent.
      for (const prompt of prompts) {
        const promptText = text(field(prompt, 'text'));
        if (promptText) await $.prompt.submit({ text: promptText, asUser: true });
      }
    }

    $.clock.every(POLL_MS, oneAtATime(takePrompts));
    return result;
  });

  on('command.run', { command: 'joc-login' }, async ($, e) => ({ text: await login($, e.args) }));
  on('command.run', { command: 'joc-logout' }, async ($) => ({ text: await logout($) }));
};

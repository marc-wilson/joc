// Delivers prompts typed in the JOC dashboard into this session, keeps the server in sync with
// it between hooks, and links the machine to a JOC account with `/joc-login`. Reporting the
// session's state and conversation is done by the command hooks in hooks.json (src/hook.ts).
// Every SYNC_MS this module runs hook.ts with a `Sync` event, so a session shows up without
// activity (e.g. open before the plugin loaded), a backlog the server missed while down gets
// sent, and the diff refreshes when files change outside Claude. What a sync prints is GitHub
// news to raise as a native notification (src/notifications.ts); JOC_NOTIFY=0 keeps it quiet.
// It also starts the new sessions the dashboard asks this one for, such as a PR review, as
// background sessions in this session's folder.
//
// Nothing here ever shows an error in the session. What fails goes to the plugin's local problem
// log (problems.ts), which `/joc-status` reads on demand. The one thing it does say unasked: when
// the server answers that this plugin is behind, a toast once per session pointing at
// `/joc-update`, which updates it.
import type { MessagesReport } from '@joc/protocol';
import type { EngineInterface, HttpResponse, ProcessRunResult, Register } from 'claude-code';
import {
  age,
  applyOutcomes,
  describeProblem,
  errorDetail,
  exitDetail,
  formatStatus,
  type Outcome,
  type PluginStatus,
  parseStatus,
  responseOutcome,
  STATUS_PATH,
} from './problems.ts';
import { LATEST_HEADER, manifestVersion, versionHeader } from './version.ts';

const POLL_MS = 2000;
const SYNC_MS = 30_000;
const SYNC_TIMEOUT_MS = 60_000;
const CHECK_TIMEOUT_MS = 5000;
const SAVE_TIMEOUT_MS = 60_000;
const UPDATE_TIMEOUT_MS = 120_000;
const DEFAULT_SERVER = 'https://joc.marcswilson.com';
/** Under the home folder; src/credentials.ts reads the same file for the command hooks. */
const CREDENTIALS = '.claude/joc/credentials.json';
/** The prompt poll's path in the problem log, the same for every session. */
const CLAIM_PATH = '/api/sessions/{id}/prompts/claim';
/** The launch poll's: new sessions, such as a PR review, to start beside this one. */
const LAUNCH_PATH = '/api/sessions/{id}/launches/claim';
const LAUNCH_POLL_MS = 5000;
/** `claude --bg` returns once the session is running. */
const LAUNCH_TIMEOUT_MS = 60_000;
/** Outcomes held between writes to the log; a poll every 2s makes 15 per write. */
const MAX_PENDING = 200;
/** Problems `/joc-status` lists. */
const SHOWN_PROBLEMS = 8;
/** What updates the plugin, run by `/joc-update` and shown when it can't. */
const UPDATE_STEPS = [
  ['claude', 'plugin', 'marketplace', 'update', 'joc'],
  ['claude', 'plugin', 'update', 'joc@joc'],
];
const RELOAD = 'reload-plugins';

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

/** The plugin's folder: `$.plugin.root`, which may name its .claude-plugin folder. */
const pluginRoot = ($: EngineInterface) =>
  $.plugin.root.replace(/\/+$/, '').replace(/\/\.claude-plugin$/, '');

let ownVersion: Promise<string | undefined> | undefined;

/** This plugin's version, from its manifest; read once. Undefined when it can't be read. */
function pluginVersion($: EngineInterface): Promise<string | undefined> {
  ownVersion ??= $.fs
    .read(`${pluginRoot($)}/.claude-plugin/plugin.json`)
    .then(manifestVersion)
    // Unreadable: requests go without a version, as an older plugin's do.
    .catch(() => undefined);
  return ownVersion;
}

/** Runs `task` unless its last run is still going; never throws, `failed` hears why instead. */
function oneAtATime(
  task: () => Promise<unknown>,
  failed: (error: unknown) => void = () => {},
): () => void {
  let busy = false;
  return () => {
    if (busy) return;
    busy = true;
    task()
      // Never to the session: the server being down, or a bug here, must not bother it.
      .catch(failed)
      .finally(() => {
        busy = false;
      });
  };
}

const crash = (where: string, detail: string): Outcome => ({
  ok: false,
  kind: 'crash',
  where,
  detail,
  at: Date.now(),
});

async function homePath($: EngineInterface, path: string): Promise<string | undefined> {
  const home = await $.env.get('HOME');
  return home ? `${home}/${path}` : undefined;
}

async function readStatusText($: EngineInterface): Promise<string | undefined> {
  const path = await homePath($, STATUS_PATH);
  return path && (await $.fs.exists(path)) ? $.fs.read(path) : undefined;
}

/**
 * This module's side of the problem log: outcomes are noted as they happen and written together
 * (`writeOutcomes`) every sync, so a poll every 2s isn't a file write every 2s.
 */
function problemLog() {
  let pending: Outcome[] = [];
  return {
    note(outcome: Outcome) {
      pending = [...pending, outcome].slice(-MAX_PENDING);
    },
    take(): Outcome[] {
      const taken = pending;
      pending = [];
      return taken;
    },
  };
}

async function writeOutcomes($: EngineInterface, outcomes: Outcome[]): Promise<void> {
  if (!outcomes.length) return;
  const path = await homePath($, STATUS_PATH);
  if (!path) return;
  // Read late and written whole, as hook.ts does; a hook writing at the same moment can lose its
  // change, which only costs a line of diagnostics.
  const before = await readStatusText($);
  const after = formatStatus(applyOutcomes(parseStatus(before), outcomes));
  if (after !== before) await $.fs.write(path, after);
}

/** A parsed JSON body's field, or undefined. The module has no zod: it's dependency-free. */
function field(body: unknown, key: string): unknown {
  if (!body || typeof body !== 'object') return undefined;
  return Object.entries(body).find(([k]) => k === key)?.[1];
}

const text = (value: unknown) => (typeof value === 'string' ? value : undefined);

const credentialsPath = ($: EngineInterface) => homePath($, CREDENTIALS);

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
  const headers: Record<string, string> = {
    ...versionHeader(await pluginVersion($)),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
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

  const version = versionHeader(await pluginVersion($));
  const res = await $.http.fetch(`${url}/api/devices/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...version },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) return `JOC: couldn't reach ${url} to link this machine (HTTP ${res.status}).`;
  const start: unknown = JSON.parse(res.text);
  const deviceCode = text(field(start, 'deviceCode'));
  const userCode = text(field(start, 'userCode'));
  const verificationUri = text(field(start, 'verificationUri'));
  // Servers from before the ready-made link send only the bare page.
  const linkUrl = text(field(start, 'verificationUriComplete')) ?? verificationUri;
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
        headers: { 'content-type': 'application/json', ...version },
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
    'To link this machine to JOC, open:',
    '',
    `    ${linkUrl}`,
    '',
    `and check the page shows the code ${userCode}. It expires in ${Math.round(expiresIn / 60)} minutes.`,
  ].join('\n');
}

/** Past this many at once, one notification says how many instead. */
const NOTIFY_MAX = 3;

/**
 * Shows the GitHub news a sync printed (src/notifications.ts): review requests, mentions, failed
 * CI. hook.ts already kept it to what this machine hasn't notified, and to one session's sync.
 */
async function notify($: EngineInterface, stdout: string) {
  const alerts = stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .flatMap((line) => {
      let list: unknown;
      try {
        list = field(JSON.parse(line), 'notify');
      } catch {
        // Not one of hook.ts's lines: nothing to show.
        return [];
      }
      return Array.isArray(list) ? list : [];
    })
    .flatMap((alert) => {
      const title = text(field(alert, 'title'));
      const body = text(field(alert, 'text'));
      return title && body ? [{ title, body }] : [];
    });
  if (alerts.length > NOTIFY_MAX) {
    await $.ui.notify(`${alerts.length} new on GitHub need you. See the Inbox in JOC.`, {
      title: 'JOC',
    });
    return;
  }
  for (const { title, body } of alerts) await $.ui.notify(body, { title });
}

async function logout($: EngineInterface): Promise<string> {
  const path = await credentialsPath($);
  if (!path || !(await $.fs.exists(path))) return "JOC: this machine isn't linked.";
  // $.fs can't delete; an empty object reads as no link.
  await $.fs.write(path, '{}\n');
  return 'JOC: this machine is unlinked. To revoke its token on the server too, remove it under Machines in the dashboard.';
}

/** What the server says about this machine's connection, and the plugin version it expects. */
async function checkServer($: EngineInterface): Promise<{ text: string; latest?: string }> {
  const { url, headers } = await connection($);
  const timeout = $.clock.sleep(CHECK_TIMEOUT_MS).then(() => undefined);
  let res: HttpResponse | undefined;
  try {
    res = await Promise.race([$.http.fetch(`${url}/api/auth`, { headers }), timeout]);
  } catch (error) {
    return { text: `Can't reach it: ${errorDetail(error)}` };
  }
  if (!res) return { text: `Can't reach it: no answer in ${CHECK_TIMEOUT_MS / 1000}s.` };
  return { text: authAnswer(res, !!headers.authorization), latest: res.headers[LATEST_HEADER] };
}

/** What `/api/auth`'s answer says about this machine's link, in a sentence. */
function authAnswer(res: HttpResponse, hasToken: boolean): string {
  if (!res.ok) return `It answers, but with HTTP ${res.status}.`;
  let body: unknown;
  try {
    body = JSON.parse(res.text);
  } catch {
    // Something else is at that address.
    return 'It answers, but not as a JOC server does. Check the address.';
  }
  if (field(body, 'required') === false) return 'Reachable. An open local server: no sign-in.';
  const login = text(field(field(body, 'user'), 'login'));
  if (field(body, 'signedIn') === true) return `Reachable. Reporting as @${login ?? 'you'}.`;
  if (hasToken) {
    return "Reachable, but it refused this machine's token (revoked, or from another server). Run /joc-login to link it again.";
  }
  return "Reachable, but this machine isn't linked. Run /joc-login.";
}

/** `/joc-status`: where this machine reports, whether that works, and what went wrong lately. */
async function status($: EngineInterface): Promise<string> {
  const now = Date.now();
  // An unreadable link file counts as no link, as it does for reporting.
  const linked = await readCredentials($).catch(() => undefined);
  const { url } = await connection($);
  const source = (await $.env.get('JOC_URL'))
    ? 'from JOC_URL'
    : linked
      ? 'linked with /joc-login'
      : 'not linked: the local dev default';
  // A broken log reads as an empty one, as everywhere else.
  const log: PluginStatus = parseStatus(await readStatusText($).catch(() => undefined));
  const problems = log.problems.slice(-SHOWN_PROBLEMS).reverse();
  const server = await checkServer($);
  const version = (await pluginVersion($)) ?? 'unknown';
  return [
    'JOC status',
    '',
    `  Server  ${url} (${source})`,
    `          ${server.text}`,
    server.latest
      ? `  Plugin  ${version}, behind ${server.latest}. Run /joc-update.`
      : `  Plugin  ${version}`,
    `  Last report the server took: ${log.lastOkAt ? `${age(now - log.lastOkAt)} ago` : 'none recorded'}`,
    '',
    problems.length
      ? `Recent problems, newest first (from ~/${STATUS_PATH}):`
      : `No problems recorded in ~/${STATUS_PATH}.`,
    ...problems.map((p) => describeProblem(p, now)),
  ].join('\n');
}

/** `/name args` from the dashboard, a command to run; undefined for a prompt, which a path such
 * as `/src/app.ts is broken` is. */
function slashCommand(line: string): { command: string; args: string } | undefined {
  const match = line.match(/^\/([\w:.-]+)(?:\s+([\s\S]*))?$/);
  return match?.[1] ? { command: match[1], args: match[2]?.trim() ?? '' } : undefined;
}

/**
 * Runs a slash command sent from the dashboard as if typed: built-in, plugin, skill and MCP
 * commands alike. `$.prompt.submit` would only send its text to Claude. One that can't run says
 * why in the conversation, as nothing else would.
 */
async function runCommand(
  $: EngineInterface,
  slash: { command: string; args: string },
  promptId: string,
): Promise<void> {
  try {
    await $.command.run(slash);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const { url, headers } = await connection($);
    const at = new Date().toISOString();
    const id = `joc-${promptId}`;
    const report: MessagesReport = {
      sessionId: await $.session.id(),
      items: [
        { id, at, kind: 'command', name: slash.command.slice(0, 100), args: slash.args },
        {
          id: `${id}:output`,
          at,
          kind: 'command_output',
          commandId: id,
          text: `Couldn't run /${slash.command} from JOC: ${reason}`.slice(0, 5000),
          isError: true,
        },
      ],
    };
    await $.http
      .fetch(`${url}/api/messages`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(report),
      })
      .catch(() => undefined); // The server being down must not hold up the prompts after it.
  }
}

/** Set once the session starts: reports the conversation a moment from now. */
let syncSoon: (() => void) | undefined;

const shown = (argv: readonly string[]) => argv.join(' ');

/** The last line a command printed, for saying how it went. */
const lastLine = (out: string) => out.trim().split('\n').at(-1)?.trim() ?? '';

/**
 * `/joc-update`: refreshes the JOC marketplace and updates the plugin through the `claude` CLI,
 * then reloads plugins so the session runs the new version. Whatever it can't do, it says how
 * to do by hand.
 */
async function update($: EngineInterface): Promise<string> {
  const manual = [
    'To update by hand, run in a terminal:',
    '',
    `    ${UPDATE_STEPS.map(shown).join(' && ')}`,
    '',
    `then /${RELOAD} here.`,
  ];
  const lines: string[] = [];
  for (const argv of UPDATE_STEPS) {
    let run: ProcessRunResult;
    try {
      run = await $.process.run(argv, { timeoutMs: UPDATE_TIMEOUT_MS });
    } catch (error) {
      return [`JOC: couldn't run ${shown(argv)}: ${errorDetail(error)}`, '', ...manual].join('\n');
    }
    if (run.exitCode !== 0) {
      const why = lastLine(run.stderr) || lastLine(run.stdout) || `exit code ${run.exitCode}`;
      return [`JOC: ${shown(argv)} failed: ${why}`, '', ...manual].join('\n');
    }
    lines.push(`  ${shown(argv)}: ${lastLine(run.stdout) || 'done'}`);
  }
  // The new version only runs once plugins reload. A command can't run inside another, so the
  // reload is queued for when this one has finished.
  // No list (an older host): no reload to queue, so the answer says to run it.
  const canReload = (await $.command.list().catch(() => [])).some((c) => c.name === RELOAD);
  if (canReload) {
    $.clock.after(1, () => {
      // Refused (a host without it, a turn starting): the answer below already says what to run.
      $.command.run({ command: RELOAD }).catch(() => {});
    });
  }
  return [
    'JOC: plugin updated.',
    ...lines,
    '',
    canReload
      ? `Reloading plugins now. If the new version doesn't show in /joc-status, run /${RELOAD}.`
      : `Run /${RELOAD} to start using it.`,
  ].join('\n');
}

export const register: Register = (on) => {
  const log = problemLog();
  const failedIn = (where: string) => (error: unknown) =>
    log.note(crash(where, errorDetail(error)));

  on('session.start', async ($, e, next) => {
    const result = await next(e);
    await $.command.register({ name: 'joc-login', description: 'Link this machine to JOC' });
    await $.command.register({ name: 'joc-logout', description: 'Unlink this machine from JOC' });
    await $.command.register({
      name: 'joc-status',
      description: "Check this machine's link to JOC and its recent problems",
    });
    await $.command.register({
      name: 'joc-update',
      description: 'Update the JOC plugin to the version the server expects',
    });
    const root = pluginRoot($);

    // Every session, as the command hooks report every session. hook.ts finds the server and
    // token the same way this module does (src/credentials.ts).
    const sync = oneAtATime(async () => {
      // Read each time: a /clear starts a new session id without a new session.start.
      const event = {
        hook_event_name: 'Sync',
        session_id: await $.session.id(),
        cwd: await $.session.cwd(),
        // A -p run has no terminal to notify in, so it leaves GitHub's news for one that does.
        can_notify: e.isInteractive,
      };
      // hook.ts records its own problems; this catches the ones where it can't run at all (Node
      // missing, a syntax error after an edit), which it then can't tell anyone about.
      try {
        const run = await $.process.run(['node', `${root}/src/hook.ts`], {
          stdin: JSON.stringify(event),
          // An empty value makes hook.ts use its own folder rather than one this process has.
          env: { CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: pluginData(root) ?? '' },
          timeoutMs: SYNC_TIMEOUT_MS,
        });
        if (run.exitCode !== 0) log.note(crash('hook', exitDetail(run.exitCode, run.stderr)));
        else await notify($, run.stdout);
      } catch (error) {
        log.note(crash('hook', errorDetail(error)));
      }
      // This module got round to a sync: an error it had before is over.
      log.note({ ok: true, where: 'module', at: Date.now() });
      await writeOutcomes($, log.take());
    }, failedIn('module'));
    $.clock.after(1, sync);
    syncSoon = () => $.clock.after(1000, sync);
    $.clock.every(SYNC_MS, sync);

    // Nobody reads a -p run's dashboard; only take prompts for sessions a person runs.
    if (!e.isInteractive) return result;

    async function takePrompts() {
      const { url, headers } = await connection($);
      const sessionId = await $.session.id();
      let res: HttpResponse;
      try {
        res = await $.http.fetch(
          `${url}/api/sessions/${encodeURIComponent(sessionId)}/prompts/claim`,
          { method: 'POST', headers },
        );
      } catch (error) {
        const detail = errorDetail(error);
        log.note({ ok: false, kind: 'unreachable', where: url, detail, at: Date.now() });
        return;
      }
      log.note(
        responseOutcome({ status: res.status, body: res.text }, CLAIM_PATH, url, Date.now()),
      );
      await warnIfBehind(res);
      if (!res.ok) return;
      const prompts = field(JSON.parse(res.text), 'prompts');
      if (!Array.isArray(prompts)) return;
      // Each starts its own turn once the session is idle, in the order they were sent.
      for (const prompt of prompts) {
        const lines = [text(field(prompt, 'text')) ?? '', ...(await saveImages(prompt))];
        const promptText = lines.filter(Boolean).join('\n\n');
        // A command carries no images; with them, the text is a prompt.
        const command = lines.length === 1 ? slashCommand(promptText) : undefined;
        const id = text(field(prompt, 'id')) ?? String(Date.now());
        if (command) await runCommand($, command, id);
        else if (promptText) await $.prompt.submit({ text: promptText, asUser: true });
      }
    }

    /**
     * A prompt can't carry an image, but Claude reads an image file a prompt names. Node saves
     * the prompt's images (src/save-images.ts), as this module can't write bytes, and answers
     * with a line per image naming its file. Never throws: a line says when an image is missing.
     */
    async function saveImages(prompt: unknown): Promise<string[]> {
      const images = field(prompt, 'images');
      if (!Array.isArray(images) || images.length === 0) return [];
      const missing = images.map(() => '[An image sent from JOC could not be loaded]');
      const run = await $.process
        .run(['node', `${root}/src/save-images.ts`], {
          stdin: JSON.stringify({ images }),
          timeoutMs: SAVE_TIMEOUT_MS,
        })
        .catch(() => undefined); // Node missing or too slow: the lines say so.
      if (run?.exitCode !== 0) return missing;
      try {
        const lines = field(JSON.parse(run.stdout), 'lines');
        return Array.isArray(lines) ? lines.flatMap((l) => text(l) ?? []) : missing;
      } catch {
        // Output that isn't the expected JSON: the images count as missing.
        return missing;
      }
    }

    let warned = false;
    /** Once per session: the server said this plugin is behind the version it expects. */
    async function warnIfBehind(res: HttpResponse) {
      const latest = res.headers[LATEST_HEADER];
      if (warned || !latest) return;
      warned = true;
      const version = (await pluginVersion($)) ?? 'unknown';
      $.ui.toast(`JOC: plugin ${version} is behind ${latest}. Run /joc-update.`, {
        timeoutMs: 10_000,
      });
    }

    /**
     * Starts the new sessions the dashboard asked this one to start, such as a PR review: each
     * a background session (`claude --bg`) in this session's folder, under the id and name the
     * server chose, so the dashboard links to it before it reports. It lives on its own, past
     * this session; `claude attach` opens it. How it went goes back to the server.
     */
    async function takeLaunches() {
      const { url, headers } = await connection($);
      const sessionId = await $.session.id();
      let res: HttpResponse;
      try {
        res = await $.http.fetch(
          `${url}/api/sessions/${encodeURIComponent(sessionId)}/launches/claim`,
          { method: 'POST', headers },
        );
      } catch (error) {
        const detail = errorDetail(error);
        log.note({ ok: false, kind: 'unreachable', where: url, detail, at: Date.now() });
        return;
      }
      log.note(
        responseOutcome({ status: res.status, body: res.text }, LAUNCH_PATH, url, Date.now()),
      );
      // An older server has no launches.
      if (!res.ok) return;
      const launches = field(JSON.parse(res.text), 'launches');
      if (!Array.isArray(launches)) return;
      const cwd = await $.session.cwd();
      for (const launch of launches) {
        const id = text(field(launch, 'id'));
        const newId = text(field(launch, 'sessionId'));
        const prompt = text(field(launch, 'prompt'));
        if (!id || !newId || !prompt) continue;
        const name = text(field(launch, 'name')) ?? 'JOC';
        const argv = ['claude', '--bg', '--session-id', newId, '--name', name, '--', prompt];
        let outcome: { ok: boolean; detail?: string };
        try {
          const run = await $.process.run(argv, { cwd, timeoutMs: LAUNCH_TIMEOUT_MS });
          outcome =
            run.exitCode === 0
              ? { ok: true }
              : {
                  ok: false,
                  detail: (
                    lastLine(run.stderr) ||
                    lastLine(run.stdout) ||
                    `claude exited with code ${run.exitCode}`
                  ).slice(0, 500),
                };
        } catch (error) {
          outcome = {
            ok: false,
            detail: `Couldn't run claude: ${errorDetail(error)}`.slice(0, 500),
          };
        }
        await $.http
          .fetch(`${url}/api/launches/${encodeURIComponent(id)}/result`, {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify(outcome),
          })
          .catch(() => undefined); // The dashboard then says the launch didn't report back.
      }
    }

    $.clock.every(POLL_MS, oneAtATime(takePrompts, failedIn('module')));
    $.clock.every(LAUNCH_POLL_MS, oneAtATime(takeLaunches, failedIn('module')));
    return result;
  });

  // No hook reports a built-in command (no prompt, no tool), so it would wait for the next sync.
  on('command.run', async (_$, e, next) => {
    const result = await next(e);
    try {
      syncSoon?.();
    } catch {
      // Reporting is best effort; the command has run either way.
    }
    return result;
  });
  on('command.run', { command: 'joc-login' }, async ($, e) => ({ text: await login($, e.args) }));
  on('command.run', { command: 'joc-logout' }, async ($) => ({ text: await logout($) }));
  on('command.run', { command: 'joc-update' }, async ($) => ({ text: await update($) }));
  on('command.run', { command: 'joc-status' }, async ($) => {
    // So the answer includes what this session noted since its last sync. A failed write only
    // leaves those out.
    await writeOutcomes($, log.take()).catch(() => {});
    return { text: await status($) };
  });
};

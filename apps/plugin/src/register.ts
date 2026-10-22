// Delivers prompts typed in the JOC dashboard into this session, keeps the server in sync with
// it between hooks, and links the machine to a JOC account with `/joc-login`. Reporting the
// session's state and conversation is done by the command hooks in hooks.json (src/hook.ts).
// Every SYNC_MS this module runs hook.ts with a `Sync` event, so a session shows up without
// activity (e.g. open before the plugin loaded), a backlog the server missed while down gets
// sent, and the diff refreshes when files change outside Claude. It also starts the new sessions the dashboard asks this one for, such as a PR review, as
// background sessions in this session's folder, and resumes the ended sessions on this machine
// the dashboard asks to resume (src/resume-session.ts).
//
// Nothing here ever shows an error in the session. What fails goes to the plugin's local problem
// log (problems.ts), which `/joc-status` reads on demand. The one thing it does say unasked: when
// the server answers that this plugin is behind, a toast once per session pointing at
// `/joc-update`, which updates it.
//
// It also tells the server which slash commands this session has (src/commands.ts), so the
// dashboard's composer can suggest them: when the session starts, and again whenever the list
// changes, such as after /reload-plugins. And what the session runs on, for its Status view
// (src/session-status.ts): Claude Code's version, the model, the folder and its MCP servers.
import type { MessagesReport, PromptHandoff } from '@joc/protocol';
import type { EngineInterface, HttpResponse, ProcessRunResult, Register } from 'claude-code';
import {
  type DescribedCommand,
  describedKey,
  type ListedCommand,
  providerOf,
  slashCommands,
} from './commands.ts';
import { backgroundId, launchArgv, sessionIdFor } from './launch.ts';
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
import {
  type ContextTool,
  configuredServers,
  mcpServers,
  statusKey,
  statusReport,
} from './session-status.ts';
import { LATEST_HEADER, manifestVersion, versionHeader } from './version.ts';
import {
  ANSWER_POLL_MS,
  answerOf,
  type Decision,
  decisionFor,
  inputKey,
  newWaitingId,
  waitingFor,
} from './waiting.ts';

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
/** Where the plugin says Claude Code took a prompt, in the problem log. */
const HANDOFF_PATH = '/api/sessions/{id}/prompts/{prompt}/handoff';
/** How long telling the server about a handoff may take before the next prompt goes on. */
const HANDOFF_TIMEOUT_MS = 5_000;
/** How long a submitted prompt has to be refused; past that, Claude Code has queued it. */
const SUBMIT_SETTLE_MS = 500;

/** A prompt Claude Code didn't take, and why, as the dashboard says it. */
const refusal = (reason: string): PromptHandoff => ({ ok: false, reason: reason.slice(0, 200) });
/** The launch poll's: new sessions, such as a PR review, to start beside this one. */
const LAUNCH_PATH = '/api/sessions/{id}/launches/claim';
const LAUNCH_POLL_MS = 5000;
/** `claude --bg` returns once the session is running. */
const LAUNCH_TIMEOUT_MS = 60_000;
/** The delete poll's: ended sessions on this machine to delete, asked for in the dashboard. */
const DELETE_PATH = '/api/deletes/claim';
const DELETE_POLL_MS = 10_000;
/** A poll or a result that gets no answer by then is given up on; the next poll tries again. */
const DELETE_HTTP_TIMEOUT_MS = 10_000;
/** delete-session.ts asks `claude agents` twice and may run `claude rm`, which removes a worktree. */
const DELETE_TIMEOUT_MS = 120_000;
/** The resume poll's: ended sessions to resume on this machine, asked for in the dashboard. */
const RESUME_PATH = '/api/resumes/claim';
const RESUME_POLL_MS = 5000;
const RESUME_HTTP_TIMEOUT_MS = 10_000;
/** resume-session.ts asks `claude agents`, then `claude --bg --resume` returns once it runs. */
const RESUME_TIMEOUT_MS = 90_000;
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
/** Where the session's slash commands go, for the dashboard's composer. */
const COMMANDS_PATH = '/api/commands';
/** `$.command.list()` answers at once; past this, the list waits for the next sync. */
const LIST_TIMEOUT_MS = 5000;
const COMMANDS_HTTP_TIMEOUT_MS = 10_000;
/** Skill folders looked for in one go, past which the rest list as plain commands. */
const MAX_SKILL_CHECKS = 200;
/** How many folders up from the session's a project's `.claude/skills` is looked for. */
const SKILL_FOLDER_DEPTH = 8;
/** Where the session's status goes, for its Status view in the dashboard. */
const STATUS_PATH_API = '/api/status';
/** MCP servers connect as the session starts: the first status waits for them. */
const STATUS_FIRST_MS = 20_000;
const STATUS_MS = 60_000;
const STATUS_HTTP_TIMEOUT_MS = 10_000;
/** Describe events kept; a session lists a few hundred commands, each a few times. */
const MAX_DESCRIBED = 5000;

interface Credentials {
  url: string;
  token: string;
}

/**
 * The folder Claude Code gives the plugin's command hooks as CLAUDE_PLUGIN_DATA, where hook.ts
 * keeps its per-session state. Not on `$`, so it's worked out from where the plugin lives:
 * `<config>/plugins/cache/<marketplace>/<plugin>/<version>` keeps its data in
 * `<config>/plugins/data/<plugin>-<marketplace>`; one loaded with `--plugin-dir` in
 * `<config>/plugins/data/<plugin>-inline`.
 */
async function pluginData($: EngineInterface, root: string): Promise<string | undefined> {
  const installed = root.match(/^(.*)\/plugins\/cache\/([^/]+)\/([^/]+)\/[^/]+$/);
  if (installed) {
    const [, config, marketplace, plugin] = installed;
    return `${config}/plugins/data/${`${plugin}@${marketplace}`.replace(/[^\w-]/g, '-')}`;
  }
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) || (await homePath($, '.claude'));
  const name = $.plugin.name.replace(/[^\w-]/g, '-');
  return config && name ? `${config}/plugins/data/${name}-inline` : undefined;
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

/** `fetch` that gives up after `ms`: undefined then, as when the server can't be reached. */
async function fetchWithin(
  $: EngineInterface,
  ms: number,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<HttpResponse | undefined> {
  const timeout = $.clock.sleep(ms).then(() => undefined);
  return Promise.race([$.http.fetch(url, init), timeout]);
}

let machineName: Promise<string | undefined> | undefined;

/**
 * This machine's name as hook.ts reports it on every session (Node's `os.hostname()` less
 * `.local`), so the server can hand it the deletes of sessions that ran here. Read once.
 */
function thisMachine($: EngineInterface): Promise<string | undefined> {
  machineName ??= $.process
    .run(['hostname'], { timeoutMs: CHECK_TIMEOUT_MS })
    .then((run) => run.stdout.trim().replace(/\.local$/, '') || undefined)
    .catch(() => undefined);
  return machineName;
}

/** What resume-session.ts printed: `{ ok, reason?, detail? }`, or undefined. */
function resumeOutcome(
  stdout: string,
): { ok: boolean; reason?: string; detail?: string } | undefined {
  let body: unknown;
  try {
    body = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const ok = field(body, 'ok');
  if (typeof ok !== 'boolean') return undefined;
  const reason = text(field(body, 'reason'));
  const detail = text(field(body, 'detail'));
  return {
    ok,
    ...(reason ? { reason: reason.slice(0, 200) } : {}),
    ...(detail ? { detail: detail.slice(0, 1000) } : {}),
  };
}

/** What delete-session.ts printed: `{ ok, removed?, detail? }`, or undefined. */
function deleteOutcome(
  stdout: string,
): { ok: boolean; removed?: string[]; detail?: string } | undefined {
  let body: unknown;
  try {
    body = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const ok = field(body, 'ok');
  if (typeof ok !== 'boolean') return undefined;
  const removed = field(body, 'removed');
  const detail = text(field(body, 'detail'));
  return {
    ok,
    ...(Array.isArray(removed)
      ? { removed: removed.flatMap((r) => text(r) ?? []).slice(0, 200) }
      : {}),
    ...(detail ? { detail: detail.slice(0, 1000) } : {}),
  };
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

/** How long a question or permission request can be answered from JOC; then only in Claude Code. */
const ANSWER_FOR_MS = 30 * 60_000;
/** Failed answer polls in a row before JOC stops offering to answer, and the pause after each. */
const ANSWER_FAILURES = 3;
const ANSWER_RETRY_MS = 1000;

/** Whether a person runs this session: only then can a question wait on JOC. */
let interactive = false;

interface RunningCall {
  tool: string;
  /** Resolves once the call is over: answered in Claude Code, or run. */
  ended: Promise<void>;
}

/** The tool calls running now, newest last, by their input (`inputKey`). */
const running = new Map<string, RunningCall[]>();

/**
 * The main loop's turns running now, by id; none between turns. Turns start only after
 * session.start, where the sync that reads this begins, and every turn heard starting is heard
 * ending, an aborted one too.
 */
const turns = new Set<string>();

/**
 * The running call a permission request is about, found by its input; failing that, the newest
 * call of that tool.
 */
function callFor(tool: string, input: unknown): RunningCall | undefined {
  const same = running.get(inputKey(tool, input));
  if (same?.length) return same.at(-1);
  return [...running.values()]
    .flat()
    .filter((c) => c.tool === tool)
    .at(-1);
}

/**
 * Offers a permission request (a question is one too) to JOC while Claude Code asks in the
 * terminal, and resolves to JOC's answer as the request's decision. The two race fairly: when
 * the terminal answers first the call ends and this stops, saying so; a JOC answer after that
 * is dropped by the server. Undefined, the terminal is the only way to answer: the server is
 * down or too old, nobody answered from JOC in time, or the call ended.
 *
 * Every wait here is an HTTP call or the call ending, which cost the hook no time, so a request
 * can wait on JOC for as long as the terminal does. Nothing is ever answered without a person's
 * answer, and an allow is for this call only.
 */
async function answerFromJoc(
  $: EngineInterface,
  tool: string,
  input: unknown,
  cwd: string,
  agent?: string,
): Promise<Decision | undefined> {
  const waitingId = newWaitingId();
  const waiting = waitingFor(waitingId, tool, input, cwd, agent);
  if (!waiting) return undefined;
  const ended = callFor(tool, input)?.ended ?? new Promise<void>(() => {});
  const over = ended.then(() => 'over' as const);
  const { url, headers } = await connection($);
  const base = `${url}/api/sessions/${encodeURIComponent(await $.session.id())}`;
  const post = (path: string, body: unknown) =>
    $.http.fetch(`${base}${path}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const done = (by?: 'joc' | 'claude-code') => {
    // Best effort: unsaid, the session's next report moves it on from waiting anyway.
    post(`/waiting/${waitingId}/done`, by ? { by } : {}).catch(() => undefined);
  };

  const told = await Promise.race([post('/waiting', waiting).catch(() => undefined), over]);
  if (told === 'over') return undefined;
  // Unreachable, or a server from before answers: the terminal alone.
  if (!told?.ok) return undefined;

  const deadline = Date.now() + ANSWER_FOR_MS;
  let failures = 0;
  while (Date.now() < deadline) {
    const claim = post('/answers/claim', { waitingId, waitMs: ANSWER_POLL_MS }).catch(
      () => undefined,
    );
    const res = await Promise.race([claim, over]);
    if (res === 'over') {
      done('claude-code');
      return undefined;
    }
    if (!res?.ok) {
      if (++failures >= ANSWER_FAILURES) break;
      await Promise.race([$.clock.sleep(ANSWER_RETRY_MS), ended]);
      continue;
    }
    failures = 0;
    let body: unknown;
    try {
      body = JSON.parse(res.text);
    } catch {
      continue;
    }
    const answer = answerOf(body);
    const decision = answer && decisionFor(waiting, answer, input);
    if (decision) {
      done('joc');
      return decision;
    }
  }
  done();
  return undefined;
}

/** Set once the session starts: reports the conversation a moment from now. */
let syncSoon: (() => void) | undefined;

/** Set once the session starts: reports its slash commands a moment from now, if they changed. */
let commandsSoon: (() => void) | undefined;

/** What the `command.describe` events said about each command, by provider and name. */
const described = new Map<string, DescribedCommand>();

/** The session and list last sent, so an unchanged list isn't sent again. */
let commandsSent: string | undefined;

/**
 * Which of the project's and the user's commands are skills: those with a `SKILL.md` under
 * `.claude/skills`, as `project\nname` / `user\nname` keys (see commands.ts). A project's skills
 * folder may be in a folder above the session's, as Claude Code reads them up the tree.
 */
async function skillKeys($: EngineInterface, listed: ListedCommand[]): Promise<Set<string>> {
  const cwd = await $.session.cwd();
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) || (await homePath($, '.claude'));
  const folders: string[] = [];
  for (let dir = cwd.replace(/\/+$/, ''); dir && folders.length < SKILL_FOLDER_DEPTH; ) {
    folders.push(dir);
    dir = dir.slice(0, dir.lastIndexOf('/'));
  }
  const names = listed
    .filter((c) => c.source === 'user' && /^[\w.-]+$/.test(c.name))
    .map((c) => c.name)
    .slice(0, MAX_SKILL_CHECKS);
  const keys = new Set<string>();
  const has = (path: string) => $.fs.exists(path).catch(() => false);
  await Promise.all(
    names.map(async (name) => {
      const project = described.has(describedKey('project', name));
      if (project) {
        const found = await Promise.all(
          folders.map((dir) => has(`${dir}/.claude/skills/${name}/SKILL.md`)),
        );
        if (found.some(Boolean)) keys.add(`project\n${name}`);
      } else if (config && (await has(`${config}/skills/${name}/SKILL.md`))) {
        keys.add(`user\n${name}`);
      }
    }),
  );
  return keys;
}

/**
 * Sends the session's slash commands to the server unless it already has this list for this
 * session. A /clear starts a new session id, so the list goes again under it.
 */
async function reportCommands($: EngineInterface, note: (outcome: Outcome) => void) {
  const timeout = $.clock.sleep(LIST_TIMEOUT_MS).then(() => undefined);
  const listed = await Promise.race([$.command.list(), timeout]);
  if (!listed) return;
  const sessionId = await $.session.id();
  const commands = slashCommands(listed, described, await skillKeys($, listed));
  const sent = `${sessionId}\n${JSON.stringify(commands)}`;
  if (sent === commandsSent) return;
  const { url, headers } = await connection($);
  let res: HttpResponse | undefined;
  try {
    res = await fetchWithin($, COMMANDS_HTTP_TIMEOUT_MS, `${url}${COMMANDS_PATH}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, at: Date.now(), commands }),
    });
  } catch (error) {
    note({
      ok: false,
      kind: 'unreachable',
      where: url,
      detail: errorDetail(error),
      at: Date.now(),
    });
    return;
  }
  // No answer in time: the next sync tries again.
  if (!res) return;
  note(responseOutcome({ status: res.status, body: res.text }, COMMANDS_PATH, url, Date.now()));
  if (res.ok) commandsSent = sent;
}

/** Set once the session starts: reports its status a moment from now, if it changed. */
let statusSoon: (() => void) | undefined;

/** The session and status last sent, so an unchanged status isn't sent again. */
let statusSent: string | undefined;

/** A settings file as parsed JSON; undefined when it's missing or isn't JSON. */
async function readJson($: EngineInterface, path: string | undefined): Promise<unknown> {
  if (!path) return undefined;
  try {
    return (await $.fs.exists(path)) ? JSON.parse(await $.fs.read(path)) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The MCP servers the session's settings set up, by name. `~/.claude.json` also holds the login;
 * only server names are taken from it, and nothing else of it is kept or sent.
 */
async function configuredMcp($: EngineInterface, root: string): Promise<string[]> {
  const dir = await $.env.get('CLAUDE_CONFIG_DIR');
  const config = dir || (await homePath($, '.claude'));
  const claudeJson = dir ? `${dir}/.claude.json` : await homePath($, '.claude.json');
  const [user, mcp, project, local, settings] = await Promise.all([
    readJson($, claudeJson),
    readJson($, `${root}/.mcp.json`),
    readJson($, `${root}/.claude/settings.json`),
    readJson($, `${root}/.claude/settings.local.json`),
    readJson($, config && `${config}/settings.json`),
  ]);
  return configuredServers({
    claudeJson: user,
    mcpJson: mcp,
    settings: [settings, project, local],
    root,
  });
}

/**
 * Sends what the session runs on unless the server already has it for this session: Claude
 * Code's version, the model, the folder, and the MCP servers with tools in the context (a
 * local estimate, no request) beside those its settings set up.
 */
async function reportStatus($: EngineInterface, note: (outcome: Outcome) => void) {
  const sessionId = await $.session.id();
  const [version, model, cwd, root, usage] = await Promise.all([
    $.session.version().then(
      (v) => v.version,
      () => undefined,
    ),
    $.session.model().catch(() => undefined),
    $.session.cwd().catch(() => undefined),
    $.session.root().catch(() => undefined),
    $.session.usage({ breakdown: 'summary' }).catch(() => undefined),
  ]);
  const tools: ContextTool[] = usage?.context.breakdown?.mcpTools ?? [];
  const configured = root ? await configuredMcp($, root) : [];
  const report = statusReport(sessionId, Date.now(), {
    version,
    model,
    cwd,
    mcp: mcpServers(tools, configured),
  });
  const sent = `${sessionId}\n${statusKey(report)}`;
  if (sent === statusSent) return;
  const { url, headers } = await connection($);
  let res: HttpResponse | undefined;
  try {
    res = await fetchWithin($, STATUS_HTTP_TIMEOUT_MS, `${url}${STATUS_PATH_API}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(report),
    });
  } catch (error) {
    note({
      ok: false,
      kind: 'unreachable',
      where: url,
      detail: errorDetail(error),
      at: Date.now(),
    });
    return;
  }
  // No answer in time: the next round tries again.
  if (!res) return;
  note(responseOutcome({ status: res.status, body: res.text }, STATUS_PATH_API, url, Date.now()));
  if (res.ok) statusSent = sent;
}

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
        // So hook.ts can settle a state left stale between turns (src/settle.ts).
        between_turns: turns.size === 0 && running.size === 0,
        checked_at: Date.now(),
      };
      // hook.ts records its own problems; this catches the ones where it can't run at all (Node
      // missing, a syntax error after an edit), which it then can't tell anyone about.
      try {
        const run = await $.process.run(['node', `${root}/src/hook.ts`], {
          stdin: JSON.stringify(event),
          // An empty value makes hook.ts use its own folder rather than one this process has.
          env: { CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: (await pluginData($, root)) ?? '' },
          timeoutMs: SYNC_TIMEOUT_MS,
        });
        if (run.exitCode !== 0) log.note(crash('hook', exitDetail(run.exitCode, run.stderr)));
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

    /**
     * Deletes the ended sessions on this machine that the dashboard asked to delete, each with
     * delete-session.ts, which checks Claude Code no longer runs it before removing anything. It
     * never deletes this session. How it went goes back to the server, which then drops its copy.
     */
    async function takeDeletes() {
      const machine = await thisMachine($);
      if (!machine) return;
      const { url, headers } = await connection($);
      const json = { ...headers, 'content-type': 'application/json' };
      let res: HttpResponse | undefined;
      try {
        res = await fetchWithin($, DELETE_HTTP_TIMEOUT_MS, `${url}${DELETE_PATH}`, {
          method: 'POST',
          headers: json,
          body: JSON.stringify({ machine }),
        });
      } catch (error) {
        const detail = errorDetail(error);
        log.note({ ok: false, kind: 'unreachable', where: url, detail, at: Date.now() });
        return;
      }
      if (!res) return;
      log.note(
        responseOutcome({ status: res.status, body: res.text }, DELETE_PATH, url, Date.now()),
      );
      // An older server has no deletes.
      if (!res.ok) return;
      const deletes = field(JSON.parse(res.text), 'deletes');
      if (!Array.isArray(deletes)) return;
      for (const request of deletes) {
        const id = text(field(request, 'id'));
        const sessionId = text(field(request, 'sessionId'));
        if (!id || !sessionId) continue;
        let outcome: { ok: boolean; removed?: string[]; detail?: string };
        if (sessionId === (await $.session.id())) {
          outcome = { ok: false, detail: `Still running on ${machine}. Quit it first.` };
        } else {
          const run = await $.process
            .run(['node', `${root}/src/delete-session.ts`], {
              stdin: JSON.stringify({ sessionId }),
              env: {
                CLAUDE_PLUGIN_ROOT: root,
                CLAUDE_PLUGIN_DATA: (await pluginData($, root)) ?? '',
              },
              timeoutMs: DELETE_TIMEOUT_MS,
            })
            .catch((error: unknown) => {
              log.note(crash('module', errorDetail(error)));
              return undefined;
            });
          outcome = (run && deleteOutcome(run.stdout)) ?? {
            ok: false,
            detail: `The JOC plugin on ${machine} couldn't run the delete. Nothing may have been deleted.`,
          };
        }
        const result = `${url}/api/deletes/${encodeURIComponent(id)}/result`;
        await fetchWithin($, DELETE_HTTP_TIMEOUT_MS, result, {
          method: 'POST',
          headers: json,
          body: JSON.stringify(outcome),
        }).catch(() => undefined); // The dashboard then says the machine didn't report back.
      }
    }
    $.clock.every(DELETE_POLL_MS, oneAtATime(takeDeletes, failedIn('module')));

    /**
     * Resumes the ended sessions the dashboard asked this machine to resume, each with
     * resume-session.ts, which checks Claude Code no longer runs it and still has its transcript,
     * then runs `claude --bg --resume` in its folder. It never resumes this session. How it went
     * goes back to the server; the resumed session then reports itself under its own id.
     */
    async function takeResumes() {
      const machine = await thisMachine($);
      if (!machine) return;
      const { url, headers } = await connection($);
      const json = { ...headers, 'content-type': 'application/json' };
      let res: HttpResponse | undefined;
      try {
        res = await fetchWithin($, RESUME_HTTP_TIMEOUT_MS, `${url}${RESUME_PATH}`, {
          method: 'POST',
          headers: json,
          body: JSON.stringify({ machine }),
        });
      } catch (error) {
        const detail = errorDetail(error);
        log.note({ ok: false, kind: 'unreachable', where: url, detail, at: Date.now() });
        return;
      }
      if (!res) return;
      log.note(
        responseOutcome({ status: res.status, body: res.text }, RESUME_PATH, url, Date.now()),
      );
      // An older server has no resumes.
      if (!res.ok) return;
      const resumes = field(JSON.parse(res.text), 'resumes');
      if (!Array.isArray(resumes)) return;
      for (const request of resumes) {
        const id = text(field(request, 'id'));
        const sessionId = text(field(request, 'sessionId'));
        if (!id || !sessionId) continue;
        let outcome: { ok: boolean; reason?: string; detail?: string };
        if (sessionId === (await $.session.id())) {
          outcome = { ok: false, reason: 'it is still running' };
        } else {
          const run = await $.process
            .run(['node', `${root}/src/resume-session.ts`], {
              stdin: JSON.stringify({ sessionId, cwd: text(field(request, 'cwd')) }),
              timeoutMs: RESUME_TIMEOUT_MS,
            })
            .catch((error: unknown) => {
              log.note(crash('module', errorDetail(error)));
              return undefined;
            });
          const why = run && (lastLine(run.stderr) || `node exited with code ${run.exitCode}`);
          outcome = (run && resumeOutcome(run.stdout)) ?? {
            ok: false,
            reason: "the JOC plugin couldn't run it",
            ...(why ? { detail: why.slice(0, 1000) } : {}),
          };
        }
        const result = `${url}/api/resumes/${encodeURIComponent(id)}/result`;
        await fetchWithin($, RESUME_HTTP_TIMEOUT_MS, result, {
          method: 'POST',
          headers: json,
          body: JSON.stringify(outcome),
        }).catch(() => undefined); // The dashboard then says the machine didn't report back.
      }
    }
    $.clock.every(RESUME_POLL_MS, oneAtATime(takeResumes, failedIn('module')));

    // Nobody reads a -p run's dashboard; only take prompts for sessions a person runs.
    interactive = e.isInteractive;
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
      // Each starts its own turn once the session is idle, in the order they were sent. Claude
      // Code queues one sent while a turn runs; the dashboard hears that it has it (a handoff),
      // so it can say the prompt waits for the turn to end rather than look stuck.
      for (const prompt of prompts) {
        const lines = [text(field(prompt, 'text')) ?? '', ...(await saveImages(prompt))];
        const promptText = lines.filter(Boolean).join('\n\n');
        // A command carries no images; with them, the text is a prompt.
        const command = lines.length === 1 ? slashCommand(promptText) : undefined;
        const id = text(field(prompt, 'id'));
        if (command) {
          // A command runs once the session is idle, and only then resolves: Claude Code has it
          // from here. One that can't run says why in the conversation (runCommand).
          const running = runCommand($, command, id ?? String(Date.now()));
          if (id) await handOff(sessionId, id, { ok: true });
          await running;
        } else if (promptText) {
          // `submit` resolves only once the prompt's turn starts, so while a turn runs it waits.
          // A refusal comes at once; past that, Claude Code has it queued. A later drop still
          // goes to the dashboard. Not awaited, so the prompts after it queue behind it.
          const entering: Promise<PromptHandoff> = $.prompt
            .submit({ text: promptText, asUser: true })
            .then((r) => (r.drop === undefined ? { ok: true } : refusal(r.drop)))
            .catch((error: unknown) => refusal(errorDetail(error)));
          const early = await Promise.race([
            entering,
            $.clock.sleep(SUBMIT_SETTLE_MS).then(() => undefined),
          ]);
          if (id) {
            await handOff(sessionId, id, early ?? { ok: true });
            if (!early) {
              void entering.then((late) => (late.ok ? undefined : handOff(sessionId, id, late)));
            }
          }
        } else if (id) {
          await handOff(sessionId, id, { ok: false, reason: 'it had nothing to send' });
        }
      }
    }

    /** Tells the server whether Claude Code took a prompt this plugin claimed. */
    async function handOff(sessionId: string, promptId: string, outcome: PromptHandoff) {
      const { url, headers } = await connection($);
      const path = `/api/sessions/${encodeURIComponent(sessionId)}/prompts/${encodeURIComponent(promptId)}/handoff`;
      const res = await fetchWithin($, HANDOFF_TIMEOUT_MS, `${url}${path}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(outcome),
      }).catch((error: unknown) => {
        log.note({
          ok: false,
          kind: 'unreachable',
          where: url,
          detail: errorDetail(error),
          at: Date.now(),
        });
        return undefined;
      });
      // The dashboard then shows the prompt as sent until the transcript has it.
      if (res) {
        log.note(
          responseOutcome({ status: res.status, body: res.text }, HANDOFF_PATH, url, Date.now()),
        );
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
     * a background session (`claude --bg`, see launch.ts) in this session's folder. It lives on
     * its own, past this session; `claude attach` opens it. How it went, and the new session's
     * id so the dashboard can open it, go back to the server.
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
      const env = { url: (await $.env.get('JOC_URL')) || undefined };
      for (const launch of launches) {
        const id = text(field(launch, 'id'));
        if (!id) continue;
        const argv = launchArgv(
          { name: text(field(launch, 'name')), prompt: text(field(launch, 'prompt')) },
          env,
        );
        let outcome: { ok: boolean; sessionId?: string; detail?: string };
        try {
          const run = await $.process.run(argv, { cwd, timeoutMs: LAUNCH_TIMEOUT_MS });
          const short = run.exitCode === 0 ? backgroundId(run.stdout) : undefined;
          if (short) {
            const agents = await $.process
              .run(['claude', 'agents', '--json'], { cwd, timeoutMs: CHECK_TIMEOUT_MS * 2 })
              .catch(() => undefined);
            const sessionId = agents && sessionIdFor(agents.stdout, short);
            outcome = { ok: true, ...(sessionId ? { sessionId } : {}) };
          } else {
            outcome = {
              ok: false,
              detail: (
                lastLine(run.stderr) ||
                lastLine(run.stdout) ||
                `claude exited with code ${run.exitCode}`
              ).slice(0, 500),
            };
          }
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

    const sendCommands = oneAtATime(() => reportCommands($, log.note), failedIn('module'));
    $.clock.after(2000, sendCommands);
    commandsSoon = () => $.clock.after(1500, sendCommands);
    $.clock.every(SYNC_MS, sendCommands);

    const sendStatus = oneAtATime(() => reportStatus($, log.note), failedIn('module'));
    $.clock.after(STATUS_FIRST_MS, sendStatus);
    statusSoon = () => $.clock.after(3000, sendStatus);
    $.clock.every(STATUS_MS, sendStatus);

    $.clock.every(POLL_MS, oneAtATime(takePrompts, failedIn('module')));
    $.clock.every(LAUNCH_POLL_MS, oneAtATime(takeLaunches, failedIn('module')));
    return result;
  });

  // Keeps track of whether a turn runs, so a sync only settles a session's state between turns.
  on('turn.start', async (_$, e, next) => {
    if (e.agentId === undefined) turns.add(e.turnId);
    return next(e);
  });
  on('turn.complete', async (_$, e, next) => {
    if (e.agentId === undefined) turns.delete(e.turnId);
    return next(e);
  });

  // Keeps track of the running tool calls, so a question or permission request offered to JOC
  // knows when Claude Code's own prompt was answered: its call goes on, then ends.
  on('tool.call', async (_$, e, next) => {
    let end = () => {};
    const call: RunningCall = {
      tool: e.tool,
      ended: new Promise<void>((resolve) => {
        end = resolve;
      }),
    };
    let key: string | undefined;
    try {
      // The tool's own arguments: the call less the keys the engine adds beside them.
      const {
        tool: _tool,
        tool_use_id: _id,
        consent: _consent,
        agentId: _agent,
        requestMeta: _meta,
        ...input
      } = e as Record<string, unknown>;
      key = inputKey(e.tool, input);
      running.set(key, [...(running.get(key) ?? []), call]);
    } catch {
      // An input that can't be keyed only loses the race's early end.
    }
    try {
      return await next(e);
    } finally {
      end();
      if (key) {
        const rest = (running.get(key) ?? []).filter((c) => c !== call);
        if (rest.length) running.set(key, rest);
        else running.delete(key);
      }
    }
  });

  // A question or permission request: answered in Claude Code or from JOC, whichever is first.
  on('classic.PermissionRequest', async ($, e, next) => {
    const below = await next(e);
    // Another hook decided, or nobody is there to answer from JOC.
    if (below.decision || !interactive) return below;
    try {
      // A teammate's request names it, so the dashboard can say which one asks.
      const { agent_id: agent } = e as { agent_id?: unknown };
      const decision = await answerFromJoc(
        $,
        e.tool_name,
        e.tool_input,
        e.cwd,
        typeof agent === 'string' && agent ? agent.slice(0, 200) : undefined,
      );
      return decision ? { ...below, decision } : below;
    } catch (error) {
      log.note(crash('module', errorDetail(error)));
      return below;
    }
  });

  // No hook reports a built-in command (no prompt, no tool), so it would wait for the next sync.
  on('command.run', async (_$, e, next) => {
    const result = await next(e);
    try {
      syncSoon?.();
      // A reload or a /clear changes the list or the session it's for; unchanged, nothing goes.
      commandsSoon?.();
      // /model, /mcp or a reload may change what the session runs on.
      statusSoon?.();
    } catch {
      // Reporting is best effort; the command has run either way.
    }
    return result;
  });
  // Each command's argument hint, whether the typeahead hides it, and whose it is: what
  // $.command.list() leaves out. Only read; the menu gets the answer from below unchanged.
  on('command.describe', async (_$, e, next) => {
    const result = await next(e);
    try {
      if (described.size >= MAX_DESCRIBED) described.clear();
      described.set(describedKey(providerOf(e.provider.plugin), e.command), {
        argumentHint: result.argumentHint,
        hidden: result.isHidden,
      });
    } catch {
      // A shape this module doesn't know only costs the hint.
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

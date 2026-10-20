// Entry point for every JOC hook: reads the hook's JSON from stdin, reports the session's state
// and any new conversation to the JOC server. It must never break or slow a Claude Code
// session, so every failure is swallowed and it always exits 0. What went wrong goes to the
// plugin's local problem log instead (problems.ts), and on to the server once it answers.
//
// Besides Claude Code's own hook events it takes `Sync`, which register.ts sends every 30s:
// it catches the server up (the conversation backlog, the diff) and refreshes the session. It
// changes the state only to settle a session whose background work ended between turns
// (settle.ts). Only a sync prints anything: the GitHub notifications for register.ts to show.
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type {
  ChangesReport,
  ImageRef,
  MessagesReport,
  ProblemsReport,
  SessionReport,
} from '@joc/protocol';
import { changesHash, collectChanges, lastSentHash, rememberSent } from './changes.ts';
import { contextLeft } from './context.ts';
import { connection, readCredentials } from './credentials.ts';
import {
  lastOwnCwd,
  movesFolder,
  rememberedFolder,
  rememberFolder,
  sessionFolder,
} from './folder.ts';
import { placeOf } from './git.ts';
import { githubDue, readGitHub } from './github.ts';
import { imageType, isImageId } from './images.ts';
import { syncNotifications } from './notifications.ts';
import {
  applyOutcomes,
  errorDetail,
  markSent,
  type Outcome,
  PROBLEMS_PATH,
  responseOutcome,
  toSend,
} from './problems.ts';
import { type EventFields, eventFields, type HookInput } from './report.ts';
import {
  lastReported,
  readTail,
  readTranscriptState,
  rememberReported,
  settledFields,
} from './settle.ts';
import { updateStatus } from './status.ts';
import {
  findTranscript,
  type Parsed,
  parseLines,
  readNewLines,
  readSubagents,
  type TranscriptImage,
} from './transcript.ts';
import {
  INSTALLED_HEADER,
  installedHeader,
  installedList,
  installedVersion,
  manifestVersion,
  PLUGIN_HEADER,
  versionHeader,
} from './version.ts';

const at = Date.now();
const { url: serverUrl, token } = connection(process.env, readCredentials());
const BATCH = 500;
const machine = hostname().replace(/\.local$/, '');

/** How each request went, and the run itself; written to the problem log once, at the end. */
const outcomes: Outcome[] = [];
/** Set once a request gets no answer: the rest would only wait out their timeouts too. */
let unreachable = false;
let ending = false;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** This plugin's version, from its manifest beside src/; undefined when it can't be read. */
function ownVersion(): string | undefined {
  try {
    return manifestVersion(
      readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'),
    );
  } catch {
    // No manifest there (a copy of src/ alone): requests go without a version.
    return undefined;
  }
}

/**
 * The plugin version installed on this machine, from Claude Code's list of installed plugins,
 * read afresh each run: an update shows at once, even from a session still running an old copy.
 * Undefined when this copy isn't an installed one, or the list can't be read. Only read.
 */
function installed(): string | undefined {
  const list = installedList(fileURLToPath(new URL('..', import.meta.url)));
  if (!list) return undefined;
  try {
    return installedVersion(readFileSync(list.file, 'utf8'), list.key);
  } catch {
    // No list there: requests go without it, as an older plugin's do.
    return undefined;
  }
}

const version = { ...versionHeader(ownVersion()), ...installedHeader(installed()) };

/** Who this machine is, and which plugin versions it runs and has installed: on every request. */
const auth = (): {
  authorization?: string;
  [PLUGIN_HEADER]?: string;
  [INSTALLED_HEADER]?: string;
} => ({
  ...version,
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

/** Sends to the server; undefined when it didn't answer. Never throws. */
async function post(path: string, body: unknown, timeoutMs: number): Promise<Response | undefined> {
  if (unreachable) return undefined;
  try {
    const response = await fetch(`${serverUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...auth(),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Only a refusal's body is read: it says why. One cut off mid-read still has its status.
    const text = response.ok ? '' : await response.text().catch(() => '');
    const answer = { status: response.status, body: text };
    outcomes.push(responseOutcome(answer, path, serverUrl, Date.now()));
    return response;
  } catch (error) {
    unreachable = true;
    const detail = errorDetail(error);
    outcomes.push({ ok: false, kind: 'unreachable', where: serverUrl, detail, at: Date.now() });
    return undefined;
  }
}

type NewConversation = Parsed & { commit: () => void };

const nothingNew: NewConversation = { items: [], images: [], commit: () => {} };

/**
 * Uploads pasted images and adds them to their items. False when the server couldn't take them
 * now, so nothing is sent and the next hook tries again; an image it refuses (too big, not an
 * image) is left out. An item that was only refused images is dropped.
 */
async function attachImages(conversation: NewConversation): Promise<boolean> {
  const byId = new Map(conversation.items.map((item) => [item.id, item]));
  for (const image of conversation.images) {
    const item = byId.get(image.itemId);
    if (item?.kind !== 'user') continue;
    const stored = await uploadImage(image);
    if (stored === 'retry') return false;
    if (stored) item.images = [...(item.images ?? []), stored];
  }
  conversation.items = conversation.items.filter(
    (item) => item.kind !== 'user' || item.text !== '' || item.images?.length,
  );
  return true;
}

async function uploadImage(image: TranscriptImage): Promise<ImageRef | undefined | 'retry'> {
  if (unreachable) return 'retry';
  let res: Response;
  try {
    res = await fetch(`${serverUrl}/api/images`, {
      method: 'POST',
      headers: { 'content-type': image.type, ...auth() },
      body: Buffer.from(image.data, 'base64'),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    unreachable = true;
    const detail = errorDetail(error);
    outcomes.push({ ok: false, kind: 'unreachable', where: serverUrl, detail, at: Date.now() });
    return 'retry';
  }
  // A refused image is left out on purpose, so only other answers count as problems.
  if ([400, 413, 415].includes(res.status)) return undefined;
  outcomes.push(
    responseOutcome({ status: res.status, body: '' }, '/api/images', serverUrl, Date.now()),
  );
  if (!res.ok) return 'retry';
  const body: unknown = await res.json();
  if (!body || typeof body !== 'object' || !('id' in body) || !('type' in body)) return undefined;
  const type = imageType(body.type);
  if (!isImageId(body.id) || !type) return undefined;
  const bytes = 'bytes' in body && typeof body.bytes === 'number' ? body.bytes : undefined;
  return { id: body.id, type, ...(bytes ? { bytes } : {}) };
}

/**
 * The session's own folder (folder.ts): a subagent's hook fires from the subagent's folder, which
 * may be another worktree on another branch. Never throws.
 */
function folderOf(input: HookInput): string {
  if (movesFolder(input)) {
    rememberFolder(input.session_id, input.cwd, at);
    return input.cwd;
  }
  return sessionFolder(input, rememberedFolder(input.session_id), () => {
    if (!input.transcript_path) return undefined;
    try {
      return lastOwnCwd(readTail(input.transcript_path, FOLDER_TAIL_BYTES));
    } catch {
      return undefined;
    }
  });
}

/** How much of the transcript's end is read for the session's folder, when none is remembered. */
const FOLDER_TAIL_BYTES = 256 * 1024;

function newConversation(input: HookInput, folder: string): NewConversation {
  if (!input.transcript_path) return nothingNew;
  try {
    const { lines, commit } = readNewLines(input.session_id, input.transcript_path);
    return { ...parseLines(lines, folder), commit };
  } catch {
    return nothingNew;
  }
}

async function main() {
  const input = JSON.parse(await readStdin()) as HookInput;
  if (!input.session_id) return;
  const event = input.hook_event_name;
  const syncing = event === 'Sync';
  if (syncing && !input.transcript_path) {
    input.transcript_path = findTranscript(input.session_id, input.cwd);
  }
  // A sync reports no state of its own, so the server keeps the one it has, unless the session
  // was left showing background work that has since ended.
  const settled = syncing ? settle(input) : undefined;
  const folder = folderOf(input);
  const fields = syncing ? (settled ?? {}) : eventFields(input);
  // A settled state counts from when register.ts saw no turn running: a turn that started since
  // reports a later time, so the server keeps that one whatever arrives first.
  const reportAt = settled && input.checked_at ? Math.min(at, input.checked_at) : at;
  ending = event === 'SessionEnd';
  const timeout = ending ? 1000 : 3000;

  // Claude Code writes the transcript asynchronously, so give the final reply a moment to land.
  if (event === 'Stop') await sleep(750);
  const conversation = ending ? nothingNew : newConversation(input, folder);

  if (fields) {
    const report: SessionReport = {
      sessionId: input.session_id,
      at: reportAt,
      ...placeOf(folder),
      machine,
      cwd: folder,
      contextLeft: ending ? undefined : contextLeft(input.transcript_path),
      ...fields,
      name: fields.name ?? conversation.aiTitle,
    };
    const response = await post('/api/reports', report, timeout);
    if (response?.ok && fields.state) remember(input.session_id, fields, reportAt);
  }

  // The images first, so the dashboard can show them as soon as their messages arrive.
  if (!(await attachImages(conversation))) return; // Keep the old position to try again.
  for (let i = 0; i < conversation.items.length; i += BATCH) {
    const batch: MessagesReport = {
      sessionId: input.session_id,
      items: conversation.items.slice(i, i + BATCH),
    };
    const response = await post('/api/messages', batch, timeout);
    if (!response?.ok) return; // Keep the old position so the next hook resends.
  }
  conversation.commit();
  if (!ending) await sendSubagentSteps(input, folder);

  if (event === 'Stop' || event === 'SessionStart' || syncing) {
    await sendChanges(input, folder);
  }
  // The person's pull requests, from whichever session's sync comes due first. JOC_GITHUB=0
  // keeps them on this machine.
  if ((syncing || event === 'SessionStart') && process.env.JOC_GITHUB !== '0' && githubDue()) {
    await post('/api/github', readGitHub(at), 10_000);
  }
  // The notifications feed, only on a sync: register.ts reads this script's output and shows
  // what it prints as native notifications (a command hook's output would go to Claude).
  if (syncing && process.env.JOC_GITHUB !== '0') {
    const alerts = await syncNotifications(post, at, input.can_notify === true);
    if (alerts.length && process.env.JOC_NOTIFY !== '0') {
      const line = `${JSON.stringify({ notify: alerts })}\n`;
      await new Promise((resolve) => process.stdout.write(line, resolve));
    }
  }
}

/** The state a sync settles on (settle.ts), or undefined to keep the server's. Never throws. */
function settle(input: HookInput): EventFields | undefined {
  if (input.between_turns !== true || !input.transcript_path) return undefined;
  try {
    const reported = lastReported(input.session_id);
    if (reported?.state !== 'background') return undefined;
    const transcript = readTranscriptState(readTail(input.transcript_path));
    return settledFields(reported, true, transcript);
  } catch {
    return undefined;
  }
}

/** Notes what the server took, for a later sync to settle from. A failed write keeps the old. */
function remember(sessionId: string, fields: EventFields, reportAt: number) {
  try {
    rememberReported(sessionId, fields, reportAt);
  } catch {}
}

/** What background subagents did, from their own transcripts, as steps of their tasks. */
async function sendSubagentSteps(input: HookInput, folder: string) {
  if (!input.transcript_path) return;
  let found: ReturnType<typeof readSubagents>;
  try {
    found = readSubagents(input.session_id, input.transcript_path);
  } catch {
    return;
  }
  for (const { task, lines, commit } of found) {
    // Pasted images stay out: a subagent's prompts come from Claude, not you.
    const { items } = parseLines(lines, folder, task);
    for (let i = 0; i < items.length; i += BATCH) {
      const batch: MessagesReport = {
        sessionId: input.session_id,
        items: items.slice(i, i + BATCH),
      };
      const response = await post('/api/messages', batch, 3000);
      if (!response?.ok) return; // Keep the old positions so the next hook resends.
    }
    commit();
  }
}

/** The diff, once per turn, when a session starts and on each sync, and only when it changed. */
async function sendChanges(input: HookInput, folder: string) {
  const changes = collectChanges(folder);
  if (!changes) return;
  const hash = changesHash(changes);
  if (hash === lastSentHash(input.session_id)) return;
  const report: ChangesReport = { sessionId: input.session_id, at, ...changes };
  const response = await post('/api/changes', report, 10_000);
  if (response?.ok) rememberSent(input.session_id, hash);
}

/**
 * Writes this run's outcomes to the problem log and, when the server took a request this run,
 * sends it the problems it hasn't seen (at most once a minute) for the Machines page.
 */
async function recordOutcomes() {
  const status = updateStatus((s) => applyOutcomes(s, outcomes));
  const answered = outcomes.some((o) => o.ok && o.where.startsWith('/'));
  // A session that's ending has no time to spare for it.
  if (ending || !answered) return;
  const problems = toSend(status, Date.now());
  if (!problems.length) return;
  const sentFrom = outcomes.length;
  const report: ProblemsReport = { machine, problems };
  const response = await post(PROBLEMS_PATH, report, 3000);
  updateStatus((s) => {
    const next = applyOutcomes(s, outcomes.slice(sentFrom));
    return response?.ok ? markSent(next, problems, Date.now()) : next;
  });
}

main()
  .then(
    () => outcomes.push({ ok: true, where: 'hook', at: Date.now() }),
    (error: unknown) => {
      const detail = errorDetail(error);
      outcomes.push({ ok: false, kind: 'crash', where: 'hook', detail, at: Date.now() });
    },
  )
  .then(recordOutcomes)
  .catch(() => {}) // An unwritable log: nothing else to tell, and the session mustn't hear of it.
  .finally(() => process.exit(0));

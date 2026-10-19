// Entry point for every JOC hook: reads the hook's JSON from stdin, reports the session's state
// and any new conversation to the JOC server. It must never break or slow a Claude Code
// session, so every failure is swallowed and it always exits 0.
//
// Besides Claude Code's own hook events it takes `Sync`, which register.ts sends every 30s:
// it catches the server up (the conversation backlog, the diff) and refreshes the session
// without changing its state.
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ChangesReport, MessagesReport, SessionReport } from '@joc/protocol';
import { changesHash, collectChanges, lastSentHash, rememberSent } from './changes.ts';
import { contextLeft } from './context.ts';
import { connection, readCredentials } from './credentials.ts';
import { branchOf, repoOf } from './git.ts';
import { githubDue, readGitHub } from './github.ts';
import { eventFields, type HookInput } from './report.ts';
import { findTranscript, type Parsed, parseLines, readNewLines } from './transcript.ts';

const at = Date.now();
const { url: serverUrl, token } = connection(process.env, readCredentials());
const BATCH = 500;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function post(path: string, body: unknown, timeoutMs: number) {
  return fetch(`${serverUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

type NewConversation = Parsed & { commit: () => void };

const nothingNew: NewConversation = { items: [], commit: () => {} };

function newConversation(input: HookInput): NewConversation {
  if (!input.transcript_path) return nothingNew;
  try {
    const { lines, commit } = readNewLines(input.session_id, input.transcript_path);
    return { ...parseLines(lines, input.cwd), commit };
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
  // A sync reports no state of its own, so the server keeps the one it has.
  const fields = syncing ? {} : eventFields(input);
  const ending = event === 'SessionEnd';
  const timeout = ending ? 1000 : 3000;

  // Claude Code writes the transcript asynchronously, so give the final reply a moment to land.
  if (event === 'Stop') await sleep(750);
  const conversation = ending ? nothingNew : newConversation(input);

  if (fields) {
    const report: SessionReport = {
      sessionId: input.session_id,
      at,
      repo: repoOf(input.cwd),
      branch: branchOf(input.cwd),
      machine: hostname().replace(/\.local$/, ''),
      cwd: input.cwd,
      contextLeft: ending ? undefined : contextLeft(input.transcript_path),
      ...fields,
      name: fields.name ?? conversation.aiTitle,
    };
    await post('/api/reports', report, timeout);
  }

  for (let i = 0; i < conversation.items.length; i += BATCH) {
    const batch: MessagesReport = {
      sessionId: input.session_id,
      items: conversation.items.slice(i, i + BATCH),
    };
    const response = await post('/api/messages', batch, timeout);
    if (!response.ok) return; // Keep the old position so the next hook resends.
  }
  conversation.commit();

  if (event === 'Stop' || event === 'SessionStart' || syncing) {
    await sendChanges(input);
  }
  // The person's pull requests, from whichever session's sync comes due first. JOC_GITHUB=0
  // keeps them on this machine.
  if ((syncing || event === 'SessionStart') && process.env.JOC_GITHUB !== '0' && githubDue()) {
    await post('/api/github', readGitHub(at), 10_000);
  }
}

/** The diff, once per turn, when a session starts and on each sync, and only when it changed. */
async function sendChanges(input: HookInput) {
  const changes = collectChanges(input.cwd);
  if (!changes) return;
  const hash = changesHash(changes);
  if (hash === lastSentHash(input.session_id)) return;
  const report: ChangesReport = { sessionId: input.session_id, at, ...changes };
  const response = await post('/api/changes', report, 10_000);
  if (response.ok) rememberSent(input.session_id, hash);
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));

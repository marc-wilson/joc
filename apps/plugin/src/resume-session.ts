// Resumes an ended Claude Code session on this machine, for a resume asked for in the JOC
// dashboard: register.ts runs it with `{ sessionId, cwd }` on stdin and sends what it prints,
// `{ ok, reason, detail }`, back to the server.
//
// What the CLI does (Claude Code 2.1): `claude --bg --resume <id>` continues the session in the
// background under the same id, so its plugin reports it as the same session again. Three cases
// it doesn't refuse, so they're checked first:
// - A session that is still running gets a copy under a new id ("started a copy as …").
// - An id with no transcript starts a new, empty session under that id.
// - Any flag passed alongside makes a background session start a copy rather than wake with
//   its own saved options, so nothing else goes on the command line. A background session keeps
//   its settings (JOC_URL among them); any other loads the plugin as installed.
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import {
  claudeFiles,
  configDir,
  isSessionId,
  runningByAgents,
  runningByRecords,
} from './forget.ts';
import { backgroundId } from './launch.ts';

const AGENTS_TIMEOUT_MS = 15_000;
/** `claude --bg` returns once the session runs. */
const RESUME_TIMEOUT_MS = 60_000;
const MAX_DETAIL = 1000;

export interface ResumeOutcome {
  ok: boolean;
  /** Short and lower case, for "Couldn't resume on <machine>: <reason>". */
  reason?: string;
  /** The one fact that helps fix it. */
  detail?: string;
}

const machine = hostname().replace(/\.local$/, '');

/** `~/code/atlas-web` for a path in the home folder. */
export function tilde(path: string, home = homedir()): string {
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** Where Claude Code keeps the transcript of a session that ran in `cwd`. */
export const transcriptPath = (config: string, cwd: string, sessionId: string) =>
  join(config, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);

/**
 * What `claude --bg --resume` printed, as an outcome: ok when it continued the session itself,
 * not when it started a copy or printed nothing it could be told by.
 */
export function resumeOutcome(
  sessionId: string,
  run: { code: number; stdout: string; stderr: string },
): ResumeOutcome {
  const lines = `${run.stderr}\n${run.stdout}`
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (run.code !== 0) {
    return {
      ok: false,
      reason: `claude exited with code ${run.code}`,
      ...(lines.length ? { detail: lines.at(-1) } : {}),
    };
  }
  const short = backgroundId(run.stdout);
  if (!short) {
    return {
      ok: false,
      reason: "claude didn't say it started",
      ...(lines.length ? { detail: lines.at(-1) } : {}),
    };
  }
  if (!sessionId.startsWith(short)) {
    const note = lines.find((l) => /copy/i.test(l));
    return {
      ok: false,
      reason: 'it was already running, so claude started a copy',
      detail: note ?? `The copy runs as ${short}.`,
    };
  }
  return { ok: true };
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command; never throws: a command that can't start or times out has code -1. */
function run(argv: string[], timeout: number, cwd?: string): Promise<Run> {
  const [file = '', ...args] = argv;
  return new Promise((resolve) => {
    execFile(file, args, { timeout, cwd, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr || error?.message || '') });
    });
  });
}

const isFolder = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

async function resume(sessionId: string, cwd: string | undefined): Promise<ResumeOutcome> {
  if (!isSessionId(sessionId)) {
    return { ok: false, reason: 'not a Claude Code session id' };
  }
  const config = configDir();
  if (cwd && !isFolder(cwd)) {
    return {
      ok: false,
      reason: `repo not found at ${tilde(cwd)}`,
      detail: `${cwd} is missing on ${machine}.`,
    };
  }
  if (!claudeFiles(config, sessionId).some((p) => p.endsWith(`${sessionId}.jsonl`))) {
    const expected = cwd
      ? tilde(transcriptPath(config, cwd, sessionId))
      : `${sessionId}.jsonl in ${tilde(join(config, 'projects'))}`;
    return {
      ok: false,
      reason: 'session file not found',
      detail: `${expected} is missing on ${machine}.`,
    };
  }
  const listed = await run(['claude', 'agents', '--json'], AGENTS_TIMEOUT_MS, cwd);
  const byAgents = listed.code === 0 ? runningByAgents(listed.stdout, sessionId) : undefined;
  const byRecords = runningByRecords(config, sessionId);
  if (byAgents || byRecords) {
    return {
      ok: false,
      reason: 'it is still running',
      detail: `Claude Code on ${machine} still runs it, so it wasn't started twice.`,
    };
  }
  if (byAgents === undefined && byRecords === undefined) {
    return {
      ok: false,
      reason: "couldn't tell whether it still runs",
      detail: `claude agents didn't answer on ${machine}.`,
    };
  }
  return resumeOutcome(
    sessionId,
    await run(['claude', '--bg', '--resume', sessionId], RESUME_TIMEOUT_MS, cwd || homedir()),
  );
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const input = JSON.parse(await readStdin()) as { sessionId?: unknown; cwd?: unknown } | null;
  const sessionId = typeof input?.sessionId === 'string' ? input.sessionId : '';
  const cwd = typeof input?.cwd === 'string' && input.cwd ? input.cwd : undefined;
  const result = await resume(sessionId, cwd).catch(
    (error: unknown): ResumeOutcome => ({
      ok: false,
      reason: "couldn't run claude",
      detail: error instanceof Error ? error.message : String(error),
    }),
  );
  const out: ResumeOutcome = {
    ...result,
    ...(result.detail ? { detail: result.detail.slice(0, MAX_DETAIL) } : {}),
  };
  // Written in full before exiting: a pipe's writes can be asynchronous.
  await new Promise<void>((resolve) => process.stdout.write(JSON.stringify(out), () => resolve()));
}

// Only when run, not when a test imports it.
if (import.meta.main) {
  main()
    .catch(() => {
      // Unreadable input: register.ts reports that no answer came.
    })
    .finally(() => process.exit(0));
}

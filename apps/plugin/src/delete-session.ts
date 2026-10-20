// Deletes an ended Claude Code session from this machine, for a delete asked for in the JOC
// dashboard: register.ts runs it with `{ sessionId }` on stdin and sends what it prints,
// `{ ok, removed, detail }`, back to the server. Run with `--dry-run` it deletes nothing and
// prints what it would remove instead.
//
// Nothing is deleted while a Claude Code process still has the session: `claude agents --json`
// and Claude Code's own records of its running processes must both say none does, checked again
// just before anything goes. A background session (`claude --bg`) is deleted by Claude Code
// itself, `claude rm`, which also removes its worktree; when that refuses (unpushed commits, a
// worktree it couldn't remove) nothing is forced and its reason goes back. For any session, the
// files forget.ts finds go: only inside Claude Code's folder, only named by the session's id,
// never through a link. Then the plugin's own read positions for it.
import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import {
  backgroundId,
  claudeFiles,
  configDir,
  isSessionId,
  pluginDataDirs,
  pluginFiles,
  removePaths,
  runningByAgents,
  runningByRecords,
} from './forget.ts';

const AGENTS_TIMEOUT_MS = 15_000;
/** `claude rm` may remove a worktree, which runs its hooks. */
const RM_TIMEOUT_MS = 60_000;
const MAX_DETAIL = 1000;

interface Result {
  ok: boolean;
  removed?: string[];
  detail?: string;
  /** With --dry-run: what would go. */
  plan?: { background?: string; paths: string[] };
}

const machine = hostname().replace(/\.local$/, '');
const STILL_RUNNING = `Still running on ${machine}. Quit it first.`;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command; never throws: a command that can't start or times out has code -1. */
function run(argv: string[], timeout: number): Promise<Run> {
  const [file = '', ...args] = argv;
  return new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr || error?.message || '') });
    });
  });
}

const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** Whether Claude Code still runs it: true, false, or undefined when nothing could tell. */
async function stillRunning(config: string, sessionId: string): Promise<boolean | undefined> {
  const listed = await run(['claude', 'agents', '--json'], AGENTS_TIMEOUT_MS);
  const byAgents = listed.code === 0 ? runningByAgents(listed.stdout, sessionId) : undefined;
  const byRecords = runningByRecords(config, sessionId);
  if (byAgents || byRecords) return true;
  if (byAgents === undefined && byRecords === undefined) return undefined;
  return false;
}

async function forget(sessionId: string, dryRun: boolean): Promise<Result> {
  if (!isSessionId(sessionId)) return { ok: false, detail: "That isn't a Claude Code session id." };
  const config = configDir();
  const running = await stillRunning(config, sessionId);
  if (running) return { ok: false, detail: STILL_RUNNING };
  if (running === undefined) {
    return {
      ok: false,
      detail: `Couldn't tell whether Claude Code still runs it on ${machine}, so nothing was deleted.`,
    };
  }
  const all = await run(['claude', 'agents', '--json', '--all'], AGENTS_TIMEOUT_MS);
  if (all.code !== 0) {
    return {
      ok: false,
      detail: `Couldn't ask Claude Code on ${machine} about it (claude agents), so nothing was deleted.`,
    };
  }
  const background = backgroundId(all.stdout, sessionId);
  const dataDirs = pluginDataDirs(config);
  const paths = () => [...claudeFiles(config, sessionId), ...pluginFiles(dataDirs, sessionId)];
  if (dryRun) return { ok: true, plan: { ...(background ? { background } : {}), paths: paths() } };

  // Again, just before: it may have been resumed since.
  if ((await stillRunning(config, sessionId)) !== false)
    return { ok: false, detail: STILL_RUNNING };

  const removed: string[] = [];
  if (background) {
    const rm = await run(['claude', 'rm', background], RM_TIMEOUT_MS);
    if (rm.code !== 0) {
      // Unpushed commits, a worktree it couldn't remove: said as Claude Code says it, not forced.
      const why = [...lines(rm.stderr), ...lines(rm.stdout)].join(' ') || `exit code ${rm.code}`;
      return { ok: false, detail: `claude rm ${background} didn't delete it: ${why}` };
    }
    removed.push(`claude rm ${background}`);
  }
  const { removed: gone, failed } = removePaths(paths(), sessionId);
  removed.push(...gone);
  if (failed.length) {
    return { ok: false, removed, detail: `Couldn't remove ${failed.join(', ')}` };
  }
  return { ok: true, removed };
}

async function main() {
  const input: unknown = JSON.parse(await readStdin());
  const sessionId = (input as { sessionId?: unknown } | null)?.sessionId;
  const dryRun = process.argv.includes('--dry-run');
  const result = await forget(typeof sessionId === 'string' ? sessionId : '', dryRun).catch(
    (error: unknown) => ({
      ok: false,
      detail: `Couldn't delete it: ${error instanceof Error ? error.message : String(error)}`,
    }),
  );
  const out: Result = {
    ...result,
    ...(result.detail ? { detail: result.detail.slice(0, MAX_DETAIL) } : {}),
  };
  // Written in full before exiting: a pipe's writes can be asynchronous.
  await new Promise<void>((resolve) => process.stdout.write(JSON.stringify(out), () => resolve()));
}

main()
  .catch(() => {
    // Unreadable input: nothing was deleted, and register.ts reports that no answer came.
  })
  .finally(() => process.exit(0));

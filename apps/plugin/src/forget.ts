// What deleting an ended session from this machine removes, and the checks before it does.
// delete-session.ts runs it; everything here only reads, except `removePaths`.
//
// Where Claude Code (2.1) keeps a session, all keyed by its id, a UUID:
// - `<config>/projects/<project>/<id>.jsonl`: the transcript `claude --resume` lists, and
//   `<config>/projects/<project>/<id>/` beside it (subagent transcripts, tool results).
// - `<config>/file-history/<id>/`: the file backups its rewinds use.
// - `<config>/session-env/<id>/`, `<config>/debug/<id>.txt`, `<config>/uploads/<id>/`,
//   `<config>/tasks/<id>/`, `<config>/todos/<id>.json`, when there are any.
// - `<config>/sessions/<pid>.json`: one per running Claude Code process, naming its session.
//   Claude Code removes it when the process exits; it is never deleted here.
// Left alone, as not keyed by the session's id: `history.jsonl` (prompts typed, shared by every
// session), `shell-snapshots/`, `paste-cache/`, `tasks/session-<short id>/`.
//
// What the JOC plugin keeps of a session, in its data folders: `offsets/<id>.offset`,
// `offsets/<id>_agent-<agent>.offset` and `changes/<id>.hash`.
import { lstatSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A Claude Code session id: the only names anything is deleted by. */
export const isSessionId = (id: unknown): id is string => typeof id === 'string' && UUID.test(id);

/** Claude Code's folder: CLAUDE_CONFIG_DIR, or `~/.claude`. */
export const configDir = (env: NodeJS.ProcessEnv = process.env) =>
  env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

/** Whether a process runs with that pid. One we may not signal is someone's, so it runs. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Whether a running Claude Code process has the session, from the records each one keeps in
 * `<config>/sessions/<pid>.json` while it runs. Undefined when they can't be read.
 */
export function runningByRecords(
  config: string,
  sessionId: string,
  alive: (pid: number) => boolean = processAlive,
): boolean | undefined {
  let names: string[];
  try {
    names = readdirSync(join(config, 'sessions'));
  } catch (error) {
    // No folder: no Claude Code process has run with this config, so none runs it.
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : undefined;
  }
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    let record: unknown;
    try {
      record = JSON.parse(readFileSync(join(config, 'sessions', name), 'utf8'));
    } catch {
      continue; // Half-written, or gone as the process exited.
    }
    const { sessionId: id, pid } = (record ?? {}) as { sessionId?: unknown; pid?: unknown };
    const owner = typeof pid === 'number' ? pid : Number(name.slice(0, -5));
    if (id === sessionId && alive(owner)) return true;
  }
  return false;
}

interface Agent {
  id?: unknown;
  sessionId?: unknown;
  kind?: unknown;
  pid?: unknown;
}

function agents(json: string): Agent[] | undefined {
  try {
    const list: unknown = JSON.parse(json);
    return Array.isArray(list) ? (list as Agent[]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether `claude agents --json`, which lists the sessions running now (interactive and
 * background), lists this one. Undefined when its output isn't that list.
 */
export function runningByAgents(json: string, sessionId: string): boolean | undefined {
  const list = agents(json);
  return list ? list.some((a) => a?.sessionId === sessionId) : undefined;
}

/**
 * The short id `claude rm` takes for the session, when `claude agents --json --all` lists it as
 * a background session; undefined for any other.
 */
export function backgroundId(json: string, sessionId: string): string | undefined {
  const agent = agents(json)?.find((a) => a?.sessionId === sessionId && a.kind === 'background');
  // Hex only: never something `claude rm` could read as an option.
  return typeof agent?.id === 'string' && /^[0-9a-f]{4,64}$/.test(agent.id) ? agent.id : undefined;
}

const inside = (root: string, path: string) => path.startsWith(root + sep);

/** A real folder (not a link) at `path`, whose real place is inside `root`. */
function realFolderInside(root: string, path: string): boolean {
  try {
    return lstatSync(path).isDirectory() && inside(root, realpathSync(path));
  } catch {
    return false;
  }
}

/** `path` itself, when it's there and not a link; links are never followed or removed. */
function present(path: string): 'file' | 'folder' | undefined {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return undefined;
    return stat.isDirectory() ? 'folder' : stat.isFile() ? 'file' : undefined;
  } catch {
    return undefined;
  }
}

/** Claude Code's files of the session on this machine: each inside `config`, named by its id. */
export function claudeFiles(config: string, sessionId: string): string[] {
  if (!isSessionId(sessionId)) return [];
  let root: string;
  try {
    root = realpathSync(config);
  } catch {
    return [];
  }
  const found: string[] = [];
  const take = (folder: string, name: string, kind: 'file' | 'folder') => {
    if (!realFolderInside(root, folder)) return;
    const path = join(folder, name);
    if (present(path) === kind) found.push(path);
  };
  const projects = join(root, 'projects');
  if (realFolderInside(root, projects)) {
    let dirs: string[] = [];
    try {
      dirs = readdirSync(projects);
    } catch {}
    for (const dir of dirs) {
      const folder = join(projects, dir);
      take(folder, `${sessionId}.jsonl`, 'file');
      take(folder, sessionId, 'folder');
    }
  }
  for (const folder of ['file-history', 'session-env', 'uploads', 'tasks']) {
    take(join(root, folder), sessionId, 'folder');
  }
  take(join(root, 'debug'), `${sessionId}.txt`, 'file');
  take(join(root, 'todos'), `${sessionId}.json`, 'file');
  return found;
}

/**
 * The folders the JOC plugin keeps per-session state in: this run's data folder, every installed
 * copy's (`<config>/plugins/data/joc-*`), and the fallback in the temp folder.
 */
export function pluginDataDirs(config: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs = new Set<string>();
  if (env.CLAUDE_PLUGIN_DATA) dirs.add(env.CLAUDE_PLUGIN_DATA);
  const data = join(config, 'plugins', 'data');
  try {
    for (const name of readdirSync(data)) if (name.startsWith('joc-')) dirs.add(join(data, name));
  } catch {}
  dirs.add(join(tmpdir(), 'joc-plugin'));
  return [...dirs];
}

/** The JOC plugin's own files of the session: read positions and the last diff's hash. */
export function pluginFiles(dirs: string[], sessionId: string): string[] {
  if (!isSessionId(sessionId)) return [];
  const found: string[] = [];
  for (const dir of dirs) {
    for (const [folder, matches] of [
      ['offsets', (n: string) => n === `${sessionId}.offset` || isAgentOffset(n, sessionId)],
      ['changes', (n: string) => n === `${sessionId}.hash`],
    ] as const) {
      const path = join(dir, folder);
      let names: string[] = [];
      try {
        if (!lstatSync(path).isDirectory()) continue;
        names = readdirSync(path);
      } catch {
        continue;
      }
      for (const name of names) {
        const file = join(path, name);
        if (matches(name) && present(file) === 'file') found.push(file);
      }
    }
  }
  return found;
}

const isAgentOffset = (name: string, sessionId: string) =>
  name.startsWith(`${sessionId}_agent-`) && /^[\w-]+\.offset$/.test(name.slice(sessionId.length));

/**
 * Removes each path, checked again as it goes: still not a link, still named by the session's
 * id. A folder's contents go with it; a link inside one is removed, never followed.
 */
export function removePaths(
  paths: string[],
  sessionId: string,
): { removed: string[]; failed: string[] } {
  const removed: string[] = [];
  const failed: string[] = [];
  for (const path of paths) {
    const name = basename(path);
    const named =
      name === sessionId || name.startsWith(`${sessionId}.`) || isAgentOffset(name, sessionId);
    if (
      !isSessionId(sessionId) ||
      !named ||
      !present(path) ||
      present(dirname(path)) !== 'folder'
    ) {
      failed.push(path);
      continue;
    }
    try {
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    } catch {
      failed.push(path);
    }
  }
  return { removed, failed };
}

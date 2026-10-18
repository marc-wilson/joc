import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Same limit as MAX_DIFF_BYTES in @joc/protocol. Copied, not imported: an installed plugin has
// no node_modules, so its runtime code imports types only.
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_UNTRACKED = 100;

// Unlike git.ts's helper, keeps stdout on a non-zero exit: `git diff --no-index` exits 1
// whenever the files differ.
function git(cwd: string, args: string[]): string | undefined {
  const run = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
    maxBuffer: 4 * MAX_DIFF_BYTES,
  });
  return run.error ? undefined : run.stdout;
}

const line = (out: string | undefined) => out?.trim() || undefined;

/** The ref the branch is compared against: origin's default branch, if there is one. */
function defaultBranch(cwd: string): string | undefined {
  const head = line(git(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']));
  if (head) return head;
  return ['origin/main', 'origin/master'].find((ref) =>
    line(git(cwd, ['rev-parse', '--verify', '--quiet', ref])),
  );
}

/** Cuts a diff at the last whole file that fits. */
function cap(diff: string): { diff: string; truncated: boolean } {
  if (Buffer.byteLength(diff) <= MAX_DIFF_BYTES) return { diff, truncated: false };
  const head = Buffer.from(diff).subarray(0, MAX_DIFF_BYTES).toString('utf8');
  const lastFile = head.lastIndexOf('\ndiff --git ');
  return { diff: lastFile > 0 ? head.slice(0, lastFile + 1) : '', truncated: true };
}

export interface Changes {
  base: string;
  diff: string;
  truncated: boolean;
}

/**
 * The working tree (committed, staged, unstaged and new files) against where the branch left
 * the default branch, or against HEAD when there's no default branch to compare with.
 */
export function collectChanges(cwd: string): Changes | undefined {
  const top = line(git(cwd, ['rev-parse', '--show-toplevel']));
  if (!top) return undefined;
  const target = defaultBranch(top);
  const mergeBase = target ? line(git(top, ['merge-base', 'HEAD', target])) : undefined;
  const base = mergeBase ? (target ?? 'HEAD') : 'HEAD';

  const flags = ['diff', '--no-color', '--no-ext-diff', '--find-renames'];
  let diff = git(top, [...flags, mergeBase ?? 'HEAD']) ?? '';
  const untracked = (git(top, ['ls-files', '--others', '--exclude-standard', '-z']) ?? '')
    .split('\0')
    .filter(Boolean)
    .slice(0, MAX_UNTRACKED);
  for (const file of untracked) {
    diff += git(top, [...flags, '--no-index', '--', '/dev/null', file]) ?? '';
  }
  return { base, ...cap(diff) };
}

function hashFile(sessionId: string): string {
  const dir = join(process.env.CLAUDE_PLUGIN_DATA ?? join(tmpdir(), 'joc-plugin'), 'changes');
  mkdirSync(dir, { recursive: true });
  return join(dir, `${sessionId.replace(/[^\w-]/g, '_')}.hash`);
}

export function changesHash(changes: Changes): string {
  return createHash('sha1').update(changes.base).update('\0').update(changes.diff).digest('hex');
}

/** The hash of the last diff the server accepted for this session. */
export function lastSentHash(sessionId: string): string | undefined {
  try {
    return readFileSync(hashFile(sessionId), 'utf8');
  } catch {
    return undefined;
  }
}

export function rememberSent(sessionId: string, hash: string): void {
  writeFileSync(hashFile(sessionId), hash);
}

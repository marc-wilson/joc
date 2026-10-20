import { execFileSync } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';

function git(cwd: string, ...args: string[]): string | undefined {
  try {
    const out = execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/** `owner/name` from a GitHub remote URL (https or ssh). */
export function parseGitHubRepo(remote: string): string | undefined {
  return remote.match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/)?.[1];
}

/** Where a folder sits in git: what a session report says about its repo, branch and worktree. */
export interface Place {
  /** GitHub `owner/name`, or the repo folder's name outside GitHub. */
  repo: string;
  /** Undefined when detached or outside a repo. */
  branch?: string;
  /** A linked worktree's folder name; empty in the repo's main checkout or outside a repo. */
  worktree: string;
}

/**
 * The repo folder's name and, for a linked worktree, the worktree's, from `git rev-parse
 * --show-toplevel --git-dir --git-common-dir` run in `cwd`. A linked worktree has a git dir of
 * its own under the main checkout's common one.
 */
export function parseTop(cwd: string, out: string | undefined): { name: string; worktree: string } {
  const [top, gitDir, commonDir] = (out ?? '').split('\n').map((l) => l.trim());
  if (!top || !gitDir || !commonDir) return { name: basename(cwd), worktree: '' };
  const common = resolve(cwd, commonDir);
  if (resolve(cwd, gitDir) === common) return { name: basename(top), worktree: '' };
  // The main checkout is the folder holding the common `.git`.
  const main = basename(common) === '.git' ? basename(dirname(common)) : basename(top);
  return { name: main, worktree: basename(top) };
}

/** The repo, branch and worktree of the folder. Three quick git calls; never throws. */
export function placeOf(cwd: string): Place {
  const remote = git(cwd, 'remote', 'get-url', 'origin');
  const fromRemote = remote ? parseGitHubRepo(remote) : undefined;
  const top = parseTop(
    cwd,
    git(cwd, 'rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir'),
  );
  const branch = git(cwd, 'branch', '--show-current');
  return { repo: fromRemote ?? top.name, worktree: top.worktree, ...(branch ? { branch } : {}) };
}

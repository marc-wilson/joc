import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

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

/** The GitHub `owner/name` for the folder, or the repo folder's name outside GitHub. */
export function repoOf(cwd: string): string {
  const remote = git(cwd, 'remote', 'get-url', 'origin');
  const fromRemote = remote ? parseGitHubRepo(remote) : undefined;
  return fromRemote ?? basename(git(cwd, 'rev-parse', '--show-toplevel') ?? cwd);
}

/** The current branch, or undefined when detached or outside a repo. */
export function branchOf(cwd: string): string | undefined {
  return git(cwd, 'branch', '--show-current');
}

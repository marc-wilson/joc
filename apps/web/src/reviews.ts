import type { CIStatus, PullRequest, PullRequestCheck } from '@joc/protocol';

/**
 * The Checks card's badge, from the checks it lists: what most needs you first, then the rest,
 * "1 failing" + "4 passed · 1 running". A skipped check counts as passed, as the counts GitHub
 * and JOC's CI line give do; skipped is the badge only when nothing else ran.
 */
export function checksBadge(checks: PullRequestCheck[]): {
  status: CIStatus;
  label: string;
  detail?: string;
} {
  const count = (s: CIStatus) => checks.filter((c) => c.status === s).length;
  const failing = count('fail');
  const running = count('pending');
  const passed = count('pass') + count('skipped');
  if (!failing && !running && !count('pass')) {
    return { status: 'skipped', label: `${count('skipped')} skipped` };
  }
  const parts = [
    passed ? `${passed} passed` : undefined,
    running ? `${running} running` : undefined,
  ].filter(Boolean);
  if (failing)
    return { status: 'fail', label: `${failing} failing`, detail: parts.join(' · ') || undefined };
  if (running) {
    return {
      status: 'pending',
      label: `${running} running`,
      detail: passed ? `${passed} passed` : undefined,
    };
  }
  return { status: 'pass', label: `${passed} passed` };
}

/** The PR's page in JOC. */
export const prHref = (pr: Pick<PullRequest, 'repo' | 'number'>) =>
  `/pr?${new URLSearchParams({ repo: pr.repo, number: String(pr.number) })}`;

/** The PR a `/pr?repo=&number=` address names, if it names one. */
export function prFromSearch(search: string): { repo: string; number: number } | undefined {
  const params = new URLSearchParams(search);
  const repo = params.get('repo');
  const number = Number(params.get('number'));
  return repo && Number.isInteger(number) && number > 0 ? { repo, number } : undefined;
}

/** The PR among the person's lists, wherever it shows. */
export function findPR(
  lists: PullRequest[][],
  pr: { repo: string; number: number },
): PullRequest | undefined {
  return lists.flat().find((p) => p.repo === pr.repo && p.number === pr.number);
}

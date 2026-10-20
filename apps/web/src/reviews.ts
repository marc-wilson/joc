import type { PullRequest } from '@joc/protocol';

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

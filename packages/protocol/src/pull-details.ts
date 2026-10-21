// Helpers for a pull request's details, shared by whoever builds a PullRequest from GitHub's data.

/** The most of a pull request's description kept; `bodyTruncated` says when there was more. */
export const MAX_PR_BODY = 20_000;
/** The most issues a pull request lists as closing. */
export const MAX_PR_CLOSES = 20;

/** A description cut to `max` characters, never mid-character, and whether it was cut. */
export function clipBody(
  body: string | null | undefined,
  max = MAX_PR_BODY,
): { body?: string; bodyTruncated?: true } {
  if (!body) return {};
  if (body.length <= max) return { body };
  // Don't leave half of a surrogate pair at the end.
  const end = /[\uD800-\uDBFF]/.test(body.charAt(max - 1)) ? max - 1 : max;
  return { body: body.slice(0, end), bodyTruncated: true };
}

const KEYWORD = '(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)';
const REPO = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[\\w.-]{1,100}';
const CLOSING = new RegExp(
  `(?:^|[^\\w/])${KEYWORD}:?\\s+(?:(${REPO})?#(\\d{1,9})|https://github\\.com/(${REPO})/issues/(\\d{1,9}))(?![\\w/-])`,
  'gi',
);

/**
 * The issues a description says the pull request closes, as GitHub reads its closing keywords:
 * `Closes #12`, `fixes harbor-labs/atlas-api#3`, `Resolves https://github.com/.../issues/9`.
 * Code is left out. `repo` is the pull request's own, for a bare `#12`.
 */
export function closingIssues(
  body: string | null | undefined,
  repo: string,
): { repo: string; number: number; url: string }[] {
  if (!body) return [];
  const text = body.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
  const found = new Map<string, { repo: string; number: number; url: string }>();
  for (const [, shortRepo, shortNumber, urlRepo, urlNumber] of text.matchAll(CLOSING)) {
    const r = urlRepo ?? shortRepo ?? repo;
    const n = Number(urlNumber ?? shortNumber);
    if (!Number.isSafeInteger(n) || n < 1) continue;
    const key = `${r.toLowerCase()}#${n}`;
    if (!found.has(key))
      found.set(key, { repo: r, number: n, url: `https://github.com/${r}/issues/${n}` });
    if (found.size >= MAX_PR_CLOSES) break;
  }
  return [...found.values()];
}

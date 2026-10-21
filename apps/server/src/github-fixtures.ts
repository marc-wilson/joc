// Test fixtures: GitHub webhook deliveries as the JOC GitHub App receives them, signed like
// GitHub signs them. Made-up harbor-labs repos and people only.
import { createHmac, randomUUID } from 'node:crypto';

export const INSTALLATION = 77;
export const REPO = 'harbor-labs/atlas-web';
export const ORG = { id: 9000, login: 'harbor-labs', type: 'Organization' };

export const PEOPLE = {
  alice: { id: 1, login: 'alice' },
  bob: { id: 2, login: 'bob' },
  carol: { id: 3, login: 'carol' },
  dana: { id: 4, login: 'dana' },
} as const;
type Person = { id: number; login: string };

const base = { installation: { id: INSTALLATION }, repository: { full_name: REPO } };

let tick = Date.parse('2026-10-20T09:00:00.000Z');
/** A later `updated_at` each call, as GitHub's would be. */
function later() {
  tick += 1000;
  return new Date(tick).toISOString();
}

export interface PullOptions {
  number?: number;
  author?: Person;
  reviewers?: Person[];
  teams?: string[];
  state?: 'open' | 'closed';
  merged?: boolean;
  sha?: string;
  title?: string;
}

export function pull({
  number = 7,
  author = PEOPLE.alice,
  reviewers = [],
  teams = [],
  state = 'open',
  merged = false,
  sha = 'a1b2c3',
  title = 'Fix the auth redirect',
}: PullOptions = {}) {
  return {
    number,
    title,
    html_url: `https://github.com/${REPO}/pull/${number}`,
    state,
    draft: false,
    merged,
    updated_at: later(),
    user: author,
    head: { ref: `fix/${number}`, sha },
    base: { ref: 'main' },
    additions: 12,
    deletions: 3,
    changed_files: 2,
    requested_reviewers: reviewers,
    requested_teams: teams.map((slug) => ({ slug })),
  };
}

export const pullEvent = (action: string, options: PullOptions = {}) => ({
  action,
  ...base,
  pull_request: pull(options),
  sender: options.author ?? PEOPLE.alice,
});

export const reviewEvent = (
  action: 'submitted' | 'dismissed',
  by: Person,
  state: 'approved' | 'changes_requested' | 'commented',
  options: PullOptions = {},
  body = '',
) => ({
  action,
  ...base,
  review: {
    id: 5000 + by.id,
    state,
    body,
    html_url: `https://github.com/${REPO}/pull/${options.number ?? 7}#pullrequestreview-${5000 + by.id}`,
    user: by,
  },
  pull_request: pull(options),
  sender: by,
});

let commentId = 8000;
export const commentEvent = (by: Person, body: string, number = 7, author = PEOPLE.alice) => {
  const id = ++commentId;
  return {
    action: 'created',
    ...base,
    issue: {
      number,
      title: 'Fix the auth redirect',
      user: author,
      pull_request: { url: `https://api.github.com/repos/${REPO}/pulls/${number}` },
    },
    comment: {
      id,
      body,
      html_url: `https://github.com/${REPO}/pull/${number}#issuecomment-${id}`,
      user: by,
    },
    sender: by,
  };
};

export const checkRunEvent = (
  name: string,
  status: 'queued' | 'in_progress' | 'completed',
  conclusion: string | null,
  sha = 'a1b2c3',
) => ({
  action: status === 'completed' ? 'completed' : 'created',
  ...base,
  check_run: {
    name,
    status,
    conclusion,
    started_at: '2026-10-20T09:00:00Z',
    completed_at: status === 'completed' ? '2026-10-20T09:01:30Z' : null,
    head_sha: sha,
    pull_requests: [],
  },
});

export const installationEvent = (action: string, sender: Person = PEOPLE.alice) => ({
  action,
  installation: { id: INSTALLATION, account: ORG, repository_selection: 'selected' },
  repositories: [{ full_name: REPO }],
  sender,
});

/** A delivery's request, signed with `secret` as GitHub signs it. */
export function delivery(
  secret: string,
  event: string,
  payload: unknown,
  id: string = randomUUID(),
) {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': id,
      'x-hub-signature-256': signature,
    },
    body,
  };
}

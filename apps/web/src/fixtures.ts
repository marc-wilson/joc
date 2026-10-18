import type { Session } from '@joc/protocol';

// Fictional sessions and conversation until the plugin reports real ones.
// Keep every name made up: no real repos, companies or people.

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

export const sessions: Session[] = [
  {
    id: 's1',
    title: 'Fix OAuth redirect loop',
    repo: 'harbor-labs/atlas-web',
    branch: 'fix/auth-redirect',
    state: 'working',
    activity: 'pnpm test atlas-web --testFile=callback.spec.ts',
    contextLeft: 64,
    machine: 'dev-mbp',
    model: 'Opus',
    updatedAt: minutesAgo(0),
  },
  {
    id: 's2',
    title: 'Dark mode for settings',
    repo: 'harbor-labs/atlas-web',
    branch: 'feat/settings-dark-mode',
    state: 'needs',
    activity: 'Asking: follow the system theme or keep a manual toggle?',
    contextLeft: 41,
    machine: 'dev-mbp',
    model: 'Opus',
    updatedAt: minutesAgo(3),
  },
  {
    id: 's3',
    title: 'Upgrade to Next.js 15.1',
    repo: 'harbor-labs/atlas-web',
    branch: 'chore/next-15-1',
    state: 'idle',
    activity: 'Done — waiting for your next message',
    contextLeft: 83,
    machine: 'dev-mbp',
    model: 'Sonnet',
    updatedAt: minutesAgo(52),
  },
  {
    id: 's4',
    title: 'Paginate invoices resolver',
    repo: 'harbor-labs/atlas-api',
    branch: 'feat/invoice-pagination',
    state: 'background',
    activity: 'pnpm e2e atlas-api-e2e (5 of 12)',
    contextLeft: 22,
    machine: 'dev-mbp',
    model: 'Opus',
    updatedAt: minutesAgo(8),
  },
  {
    id: 's5',
    title: 'Migrate mailer to Resend',
    repo: 'harbor-labs/atlas-api',
    branch: 'feat/resend-mailer',
    state: 'needs',
    activity: 'Permission: run prisma migrate deploy?',
    contextLeft: 37,
    machine: 'dev-mbp',
    model: 'Opus',
    updatedAt: minutesAgo(1),
  },
  {
    id: 's6',
    title: 'HPA for atlas-api',
    repo: 'harbor-labs/platform-infra',
    branch: 'feat/api-hpa',
    state: 'working',
    activity: 'Edit k8s/atlas-api/hpa.yaml',
    contextLeft: 55,
    machine: 'build-02',
    model: 'Sonnet',
    updatedAt: minutesAgo(0),
  },
  {
    id: 's7',
    title: 'Rotate AKS node pool',
    repo: 'harbor-labs/platform-infra',
    branch: 'ops/nodepool-rotate',
    state: 'offline',
    activity: 'Lost connection to build-02',
    contextLeft: 9,
    machine: 'build-02',
    model: 'Opus',
    updatedAt: minutesAgo(180),
  },
];

export type Turn =
  | { kind: 'user'; time: string; text: string; command?: string }
  | { kind: 'claude'; time: string; paragraphs: string[] }
  | {
      kind: 'tool';
      name: string;
      target: string;
      meta?: string;
      status?: 'running' | 'done' | 'error';
      output?: string;
    }
  | { kind: 'question'; question: string; options: { label: string; description?: string }[] };

export const conversations: Record<string, Turn[]> = {
  s1: [
    {
      kind: 'user',
      time: '10:31',
      text: 'Login bounces between /callback and /login after the token refresh. This is staging.',
    },
    {
      kind: 'claude',
      time: '10:32',
      paragraphs: [
        'Reproduced it. handleCallback reads req.query.redirect before the session cookie is validated, so an expired refresh token sends you to /login, which bounces straight back to /callback.',
        'Plan: validate the session before reading the redirect target, add safeRedirect() so only same-origin paths are followed, and cover both cases in callback.spec.ts.',
      ],
    },
    { kind: 'tool', name: 'Read', target: 'apps/web/src/auth/callback.ts', meta: '142 lines' },
    {
      kind: 'tool',
      name: 'Edit',
      target: 'apps/web/src/auth/callback.ts',
      meta: '+24 −9',
      output:
        "- const next = req.query.redirect ?? '/';\n+ if (!session?.valid) return redirect('/login');\n+ const next = safeRedirect(req.query.next) ?? '/';",
    },
    { kind: 'user', time: '10:36', command: 'test', text: 'auth, then show me any failures first' },
    {
      kind: 'tool',
      name: 'Bash',
      target: 'pnpm test atlas-web --testFile=callback.spec.ts',
      status: 'running',
    },
  ],
  s2: [
    {
      kind: 'user',
      time: '09:58',
      text: 'Add a dark mode to the settings page. Match the tokens we already have.',
    },
    {
      kind: 'claude',
      time: '10:04',
      paragraphs: [
        'The settings page now reads every colour from tokens, and both themes pass contrast checks. One decision before I wire up the switch:',
      ],
    },
    {
      kind: 'question',
      question: 'How should settings choose between light and dark?',
      options: [
        { label: 'Follow the system theme', description: 'No toggle; uses prefers-color-scheme.' },
        {
          label: 'Manual toggle',
          description: 'Light, dark or system, saved per user.',
        },
      ],
    },
  ],
};

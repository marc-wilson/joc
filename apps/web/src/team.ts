import {
  type ConversationItem,
  isLive,
  type PullRequest,
  type Session,
  type Teammate,
  teamOf,
} from '@joc/protocol';
import { latestStep, taskSteps } from './background.ts';
import { plain } from './plain.ts';

/**
 * The selected session's teammates, from its conversation as it stands here, with the folders
 * and branches only the server knows. Before its conversation loads, what the server said.
 */
export function sessionTeam(session: Session, items: ConversationItem[]): Teammate[] {
  if (!items.length) return session.team ?? [];
  return teamOf(items, {
    state: session.state,
    background: session.background,
    waiting: session.waiting,
    folders: (session.team ?? []).map((t) => ({
      task: t.id,
      ...(t.branch ? { branch: t.branch } : {}),
      ...(t.worktree ? { worktree: t.worktree } : {}),
    })),
  });
}

/** The session row's chip: how many are at work, of how many, and how many failed. */
export function teamCounts(team: Teammate[]): { active: number; total: number; failed: number } {
  return {
    active: team.filter(isLive).length,
    total: team.length,
    failed: team.filter((t) => t.status === 'failed').length,
  };
}

/** The session row's activity line while its teammates work and it waits on them. */
export function teamLine(team: Teammate[]): string | undefined {
  const live = team.filter(isLive).length;
  if (!live) return undefined;
  return `Waiting on ${live} ${live === 1 ? 'teammate' : 'teammates'}`;
}

/** How the session addresses a teammate in `SendMessage`: its agent id, or its call's id. */
const addresses = (t: Teammate, id: string | undefined) =>
  !!id && (id === t.agentId || id === t.id);

export interface TeamLine {
  id: string;
  from: 'lead' | 'mate';
  at: string;
  text: string;
}

/** The messages between the session and a teammate, oldest first. */
export function teammateMessages(items: ConversationItem[], t: Teammate): TeamLine[] {
  return items.flatMap((i): TeamLine[] => {
    if (i.task) return [];
    if (i.kind === 'tool_call' && i.message && addresses(t, i.to)) {
      return [{ id: i.id, from: 'lead', at: i.at, text: i.message }];
    }
    if (i.kind === 'agent_message' && addresses(t, i.from)) {
      return [{ id: i.id, from: 'mate', at: i.at, text: i.text }];
    }
    return [];
  });
}

/**
 * A teammate's latest report: a background one's from its last task notification, a blocking
 * one's from its call's result.
 */
export function teammateReport(
  items: ConversationItem[],
  t: Teammate,
): { text: string; at: string } | undefined {
  for (let n = items.length - 1; n >= 0; n--) {
    const i = items[n];
    if (!i || i.task) continue;
    if (i.kind === 'task_update' && (i.toolUseId === t.id || addresses(t, i.taskId))) {
      if (i.result?.trim()) return { text: i.result, at: i.at };
    }
    if (i.kind === 'tool_result' && i.toolUseId === t.id && !i.taskId && i.text.trim()) {
      return { text: i.text, at: i.at };
    }
  }
  return undefined;
}

/** What the session asked a teammate: its Agent call's prompt. */
export function teammateBrief(items: ConversationItem[], t: Teammate): string | undefined {
  const call = items.find((i) => i.kind === 'tool_call' && i.toolUseId === t.id);
  return call?.kind === 'tool_call' ? (call.prompt ?? call.description) : undefined;
}

/** A report split into its first line, as a head, and the rest. */
export function reportParts(text: string): { headline: string; rest: string } {
  const lines = text.trim().split('\n');
  const first = lines.findIndex((l) => l.trim());
  const headline = plain(lines[first]?.trim() ?? '').replace(/^#+\s*/, '');
  return {
    headline,
    rest: lines
      .slice(first + 1)
      .join('\n')
      .trim(),
  };
}

/** The pull request a teammate's branch has open, of the person's on GitHub. */
export function teammatePr(t: Teammate, prs: PullRequest[], repo: string): PullRequest | undefined {
  if (!t.branch) return undefined;
  return (
    prs.find((pr) => pr.branch === t.branch && pr.repo === repo) ??
    prs.find((pr) => pr.branch === t.branch)
  );
}

/** JOC images a report shows (`/api/images/<id>`), for the Screenshots section. */
export function reportImages(text: string | undefined): string[] {
  if (!text) return [];
  return [...new Set([...text.matchAll(/\/api\/images\/([0-9a-f]{64})\b/g)].map((m) => m[1] ?? ''))]
    .filter(Boolean)
    .slice(0, 12);
}

/** Steps shown before the earlier ones fold into one row. */
export const STEPS_SHOWN = 7;

/** A teammate's latest steps, each one line, and how many came before them. */
export function teammateSteps(
  steps: ConversationItem[],
  startedAt: string | undefined,
  running: boolean,
): {
  steps: { id: string; text: string; time: string; status: 'done' | 'fail' | 'current' }[];
  earlier: number;
  total: number;
} {
  if (!startedAt) return { steps: [], earlier: 0, total: 0 };
  const all = taskSteps(steps, startedAt, running).map((s) => ({
    id: s.id,
    text: stepText(s.tool, s.target),
    time: s.time,
    status: s.status,
  }));
  return {
    steps: all.slice(-STEPS_SHOWN),
    earlier: Math.max(0, all.length - STEPS_SHOWN),
    total: all.length,
  };
}

/** One step as a line: a command as run, any other tool before what it worked on. */
export const stepText = (tool: string, target?: string) =>
  tool === 'Bash' && target ? target : [tool, target].filter(Boolean).join(' ');

/** A row's second line: what a live teammate does or asks, where a done one left its work. */
export function teammateLine(t: Teammate, steps: ConversationItem[]): string | undefined {
  if (t.status === 'waiting') return t.tail && `Asked: ${t.tail}`;
  if (t.status === 'needs') return t.tail;
  if (t.status === 'working') {
    const last = steps.findLast((i) => i.kind === 'tool_call');
    if (last?.kind === 'tool_call') return stepText(last.name, last.summary);
    return latestStep(steps) ?? 'Starting';
  }
  if (t.status === 'done') return t.branch ?? t.tail ?? 'Done';
  return t.tail ?? (t.status === 'failed' ? 'Failed' : 'Stopped');
}

/** A run time for a list: "8s", "12m", "2h 5m". */
export function shortElapsed(from: string, to: string | number): string {
  const end = typeof to === 'number' ? to : Date.parse(to);
  const s = Math.max(0, Math.floor((end - Date.parse(from)) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** A run time for the detail, to the second: "12m 08s". */
export function longElapsed(from: string, to: string | number): string {
  const end = typeof to === 'number' ? to : Date.parse(to);
  const s = Math.max(0, Math.floor((end - Date.parse(from)) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (m < 60) return `${m}m ${pad(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
}

/** A message's or report's time of day, "10:42". */
export function timeOfDay(at: string): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** How a teammate is named in its messages: by its issue, else "Teammate". */
export const mateName = (t: Teammate) => (t.issue ? `#${t.issue}` : 'Teammate');

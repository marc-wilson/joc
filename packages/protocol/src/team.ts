import { z } from 'zod';
import type { ConversationItem, RunningTask, SessionState, Waiting } from './index.ts';

// A session's teammates: the subagents it hands work to with Claude Code's Agent tool, each with
// its own brief, steps, messages and report. Worked out from the session's own conversation, so
// the server (for the session list) and the dashboard (for the Team tab) agree.

/**
 * Where a teammate stands. `working`, `waiting` (on the session, which owes it a reply) and
 * `needs` (its question or permission request waits on you) are live; `done`, `failed` and
 * `stopped` are how it ended.
 */
export const TeammateStatus = z.enum(['working', 'waiting', 'needs', 'done', 'failed', 'stopped']);
export type TeammateStatus = z.infer<typeof TeammateStatus>;

/** The most teammates a session keeps: the latest ones. */
export const MAX_TEAMMATES = 50;

/** The folder and branch a teammate works in, as its plugin last saw them. */
export const TeamFolder = z.object({
  /** The `toolUseId` of the call that started it. */
  task: z.string().min(1).max(200),
  branch: z.string().max(300).optional(),
  /** Its worktree, relative to the session's folder when it's inside it. */
  worktree: z.string().max(300).optional(),
});
export type TeamFolder = z.infer<typeof TeamFolder>;

/** One teammate, as the session list and the Team tab show it. */
export const Teammate = z.object({
  /** The `toolUseId` of the call that started it; Claude Code's id for one only its list knows. */
  id: z.string().min(1).max(200),
  /** Claude Code's agent id, once it runs in the background: what `SendMessage` addresses. */
  agentId: z.string().max(200).optional(),
  title: z.string().max(200),
  /** The issue its title names, e.g. 81 for "Reconnect to GitHub App #81". */
  issue: z.number().int().positive().optional(),
  /** Its subagent type, e.g. `general-purpose`. */
  agentType: z.string().max(100).optional(),
  status: TeammateStatus,
  /** One line on how it ended, or what it asked the session. */
  tail: z.string().max(500).optional(),
  startedAt: z.iso.datetime().optional(),
  endedAt: z.iso.datetime().optional(),
  branch: z.string().max(300).optional(),
  worktree: z.string().max(300).optional(),
});
export type Teammate = z.infer<typeof Teammate>;

/** What else decides where teammates stand, beside the conversation. */
export interface TeamContext {
  state: SessionState;
  /** Claude Code's own list of what runs, the truth for a teammate still running. */
  background?: { at: string; tasks: RunningTask[] };
  waiting?: Waiting;
  folders?: TeamFolder[];
}

const LIVE: readonly TeammateStatus[] = ['working', 'waiting', 'needs'];

/** Whether a teammate is still at work: working, or waiting on the session or on you. */
export const isLive = (t: Pick<Teammate, 'status'>) => LIVE.includes(t.status);

/** Claude Code's list types that are agents, not shells, monitors or workflows. */
const AGENT_TYPES = ['subagent', 'teammate', 'agent'];

const STOPPED = /Successfully stopped task: ([\w-]+)/;

const firstLine = (text: string | undefined) =>
  text
    ?.split('\n')
    .map((l) => l.trim())
    .find(Boolean)
    ?.slice(0, 500);

/** The issue a title names, and the title without a trailing `#81`. */
export function teammateTitle(text: string): { title: string; issue?: number } {
  const issue = Number(text.match(/#(\d{1,7})\b/)?.[1]) || undefined;
  const title = text.replace(/\s*[([]?#\d{1,7}[)\]]?\s*$/, '').trim() || text.trim();
  return { title: title.slice(0, 200), ...(issue ? { issue } : {}) };
}

interface Draft extends Teammate {
  background: boolean;
  /** When the session last messaged it, and when it last messaged the session. */
  leadAt?: string;
  mateAt?: string;
  mateText?: string;
}

/**
 * The session's teammates, oldest first, from its own conversation (not its subagents' steps):
 * each Agent call starts one; its result (a blocking one), a task notification (a background
 * one) or a stop ends it; a `SendMessage` to one that ended starts it again, as Claude Code
 * resumes it. A live one waits on the session when its latest message, unanswered, asks
 * something, and on you while its question or permission request does.
 */
export function teamOf(items: ConversationItem[], context: TeamContext): Teammate[] {
  const team: Draft[] = [];
  const byId = new Map<string, Draft>();
  const find = (id: string | undefined) => (id ? byId.get(id) : undefined);
  const end = (t: Draft, status: TeammateStatus, at: string, tail?: string) => {
    t.status = status;
    t.endedAt = at;
    if (tail) t.tail = tail;
    else delete t.tail;
  };

  for (const item of items) {
    if (item.task) continue;
    if (item.kind === 'tool_call' && item.subagent) {
      const named = teammateTitle(item.description ?? (item.summary || 'Teammate'));
      const t: Draft = {
        id: item.toolUseId,
        ...named,
        agentType: item.subagent,
        status: 'working',
        startedAt: item.at,
        background: item.background === true,
      };
      team.push(t);
      byId.set(t.id, t);
    } else if (item.kind === 'tool_call' && item.to) {
      const t = find(item.to);
      if (!t) continue;
      t.leadAt = item.at;
      // Messaged after it ended, it's resumed with the message.
      if (!isLive(t)) {
        t.status = 'working';
        delete t.endedAt;
        delete t.tail;
      }
    } else if (item.kind === 'tool_result') {
      const stopped = STOPPED.exec(item.text)?.[1];
      const s = find(stopped);
      if (s && isLive(s)) end(s, 'stopped', item.at, 'Stopped');
      const t = find(item.toolUseId);
      if (!t) continue;
      if (item.taskId) {
        t.agentId = item.taskId;
        t.background = true;
        byId.set(item.taskId, t);
      } else if (item.isError) {
        end(t, 'failed', item.at, firstLine(item.text));
      } else if (!t.background) {
        end(t, 'done', item.at);
      }
    } else if (item.kind === 'task_update') {
      const t = find(item.toolUseId) ?? find(item.taskId);
      if (!t) continue;
      const status =
        item.status === 'completed' ? 'done' : item.status === 'failed' ? 'failed' : 'stopped';
      end(t, status, item.at, status === 'done' ? undefined : item.summary || 'Stopped');
    } else if (item.kind === 'agent_message') {
      const t = find(item.from);
      if (!t) continue;
      t.mateAt = item.at;
      t.mateText = item.text;
    }
  }

  const { background: listed, state, waiting } = context;
  const listedIds = new Set(listed?.tasks.map((t) => t.id));
  const listedAt = listed ? Date.parse(listed.at) : 0;
  for (const t of team) {
    if (!isLive(t)) continue;
    if (state === 'offline') {
      t.status = 'stopped';
      t.tail = 'The session ended';
    } else if (t.agentId && waiting?.agent === t.agentId) {
      t.status = 'needs';
      t.tail =
        waiting.kind === 'permission'
          ? `Asks to run ${waiting.tool}`
          : firstLine(waiting.questions[0]?.question);
    } else if (t.mateAt && t.mateText && (!t.leadAt || t.leadAt < t.mateAt) && asks(t.mateText)) {
      t.status = 'waiting';
      t.tail = firstLine(t.mateText);
    } else if (
      listed &&
      t.background &&
      !(t.agentId && listedIds.has(t.agentId)) &&
      t.startedAt &&
      Date.parse(t.startedAt) < listedAt
    ) {
      // Claude Code's list, newer than its start, no longer has it: it ended unsaid.
      t.status = 'stopped';
      t.tail = 'Ended';
    }
  }

  // Agents only Claude Code's list knows of: started before the transcript JOC has.
  const known = new Set(team.flatMap((t) => [t.id, t.agentId ?? '']));
  for (const task of listed?.tasks ?? []) {
    if (!AGENT_TYPES.includes(task.type) || known.has(task.id)) continue;
    const named = teammateTitle(firstLine(task.description) ?? task.name ?? 'Teammate');
    team.push({
      id: task.id,
      agentId: task.id,
      ...named,
      ...(task.agentType ? { agentType: task.agentType } : {}),
      background: true,
      ...(state === 'offline'
        ? { status: 'stopped', tail: 'The session ended' }
        : { status: 'working' }),
    });
  }

  const folders = new Map(context.folders?.map((f) => [f.task, f]));
  return team
    .slice(-MAX_TEAMMATES)
    .map(({ background: _b, leadAt: _l, mateAt: _m, mateText: _t, ...t }) => {
      const folder = folders.get(t.id);
      return {
        ...t,
        ...(folder?.branch ? { branch: folder.branch } : {}),
        ...(folder?.worktree ? { worktree: folder.worktree } : {}),
      };
    });
}

/** Whether a teammate's message asks the session something: its last line is a question. */
function asks(text: string): boolean {
  const lines = text.trim().split('\n');
  return /\?\s*$/.test(lines.at(-1) ?? '');
}

/** Active teammates, then finished ones; the newest start first in each. */
export function arrangeTeam<T extends Pick<Teammate, 'status' | 'startedAt'>>(
  team: T[],
): { active: T[]; finished: T[] } {
  const newest = (a: T, b: T) => (b.startedAt ?? '').localeCompare(a.startedAt ?? '');
  return {
    active: team.filter(isLive).sort(newest),
    finished: team.filter((t) => !isLive(t)).sort(newest),
  };
}

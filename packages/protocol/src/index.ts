import { z } from 'zod';

export const SessionState = z.enum(['working', 'background', 'needs', 'idle', 'offline']);
export type SessionState = z.infer<typeof SessionState>;

export const CIStatus = z.enum(['pass', 'fail', 'pending', 'skipped']);
export type CIStatus = z.infer<typeof CIStatus>;

/** A live Claude Code session, as the server knows it. */
export const Session = z.object({
  id: z.string(),
  /** Unset until the session's first prompt. */
  title: z.string().optional(),
  /** GitHub `owner/name`, or the folder name outside a GitHub repo. */
  repo: z.string(),
  branch: z.string().optional(),
  state: SessionState,
  /** What Claude is doing right now, one line. */
  activity: z.string().optional(),
  /** Percent of the context window left, 0–100. */
  contextLeft: z.number().min(0).max(100).optional(),
  machine: z.string().optional(),
  model: z.string().optional(),
  /** The folder the session runs in, for resuming it later. */
  cwd: z.string().optional(),
  startedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Session = z.infer<typeof Session>;

/** A past session for the History page: a session plus how many messages it has. */
export const HistorySession = Session.extend({ messages: z.number().int().nonnegative() });
export type HistorySession = z.infer<typeof HistorySession>;

/**
 * What the plugin sends on each hook event. Fields left out keep their last value; `title` is
 * only taken from the first report that has one. A report older than the last one applied is
 * dropped.
 *
 * A report without `state` (the plugin's periodic sync) refreshes the other fields and keeps the
 * state; a session first seen that way is `idle`. It never makes a later state report stale.
 */
export const SessionReport = z.object({
  sessionId: z.string().min(1),
  /** When the hook fired, ms since epoch. Hooks run async, so reports can arrive out of order. */
  at: z.number().int().positive(),
  state: SessionState.optional(),
  repo: z.string().min(1),
  branch: z.string().optional(),
  /** Fallback title, from the first prompt. Kept from the first report that has one. */
  title: z.string().max(200).optional(),
  /** Claude Code's own name for the session (a custom name or its generated title). Latest wins. */
  name: z.string().max(200).optional(),
  activity: z.string().max(500).optional(),
  contextLeft: z.number().min(0).max(100).optional(),
  machine: z.string().max(200).optional(),
  model: z.string().max(100).optional(),
  cwd: z.string().max(1000).optional(),
});
export type SessionReport = z.infer<typeof SessionReport>;

/** An open pull request, as the plugin reads it through the `gh` CLI. */
export const PullRequest = z.object({
  number: z.number().int().positive(),
  title: z.string().max(500),
  url: z.url(),
  /** `owner/name`, matching Session.repo. */
  repo: z.string().max(200),
  /** The head branch, matching Session.branch. */
  branch: z.string().max(300),
  author: z.string().max(100),
  updatedAt: z.iso.datetime(),
  draft: z.boolean(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  review: z.enum(['Approved', 'Changes requested', 'Review requested']).optional(),
  ci: CIStatus,
  /** Finished checks over all checks, e.g. `9/14`. */
  ciDetail: z.string().max(20).optional(),
});
export type PullRequest = z.infer<typeof PullRequest>;

/** What the plugin reads from GitHub for its person, about once a minute. */
export const GitHubReport = z.object({
  at: z.number().int().positive(),
  /** Whether `gh` could answer: missing and signed-out machines say so instead of sending PRs. */
  status: z.enum(['ok', 'not-installed', 'signed-out', 'error']),
  reviewRequested: z.array(PullRequest).max(100),
  mine: z.array(PullRequest).max(100),
});
export type GitHubReport = z.infer<typeof GitHubReport>;

/** `GET /api/github`: the latest report, or `none` before any machine has sent one. */
export const GitHubSnapshot = z.discriminatedUnion('state', [
  z.object({ state: z.literal('none') }),
  z.object({
    state: z.literal('reported'),
    status: GitHubReport.shape.status,
    reviewRequested: z.array(PullRequest),
    mine: z.array(PullRequest),
    updatedAt: z.iso.datetime(),
  }),
]);
export type GitHubSnapshot = z.infer<typeof GitHubSnapshot>;

/** How a background task (shell command or subagent) ended. */
export const TaskStatus = z.enum(['completed', 'failed', 'killed']);
export type TaskStatus = z.infer<typeof TaskStatus>;

const itemBase = { id: z.string().min(1).max(200), at: z.iso.datetime() };

/** One entry in a session's conversation, normalized from its transcript by the plugin. */
export const ConversationItem = z.discriminatedUnion('kind', [
  z.object({
    ...itemBase,
    kind: z.literal('user'),
    text: z.string().max(20_000),
    /** Set when the prompt was a slash command, e.g. `review`. */
    command: z.string().max(100).optional(),
  }),
  z.object({ ...itemBase, kind: z.literal('claude'), text: z.string().max(50_000) }),
  z.object({
    ...itemBase,
    kind: z.literal('tool_call'),
    toolUseId: z.string().max(200),
    name: z.string().max(200),
    /** One line on what the call touches: a command, a path, a pattern. */
    summary: z.string().max(500),
    /** What Claude said the call is for, when it said (e.g. a shell command's description). */
    description: z.string().max(200).optional(),
    /** Set when Claude asked for the call to run in the background. */
    background: z.boolean().optional(),
    /** Set on a subagent call: the subagent's type, e.g. `Explore`. */
    subagent: z.string().max(100).optional(),
  }),
  z.object({
    ...itemBase,
    kind: z.literal('tool_result'),
    toolUseId: z.string().max(200),
    isError: z.boolean(),
    text: z.string().max(5_000),
    /** Set when the call left a task running in the background; a `task_update` ends it. */
    taskId: z.string().max(200).optional(),
  }),
  z.object({
    ...itemBase,
    kind: z.literal('task_update'),
    taskId: z.string().max(200),
    /** The call that started the task, when Claude Code says. */
    toolUseId: z.string().max(200).optional(),
    status: TaskStatus,
    /** One line on how it ended, as Claude Code put it. */
    summary: z.string().max(500),
  }),
]);
export type ConversationItem = z.infer<typeof ConversationItem>;

/** What the plugin sends with new conversation items. Items are deduplicated by id. */
export const MessagesReport = z.object({
  sessionId: z.string().min(1),
  items: z.array(ConversationItem).max(500),
});
export type MessagesReport = z.infer<typeof MessagesReport>;

/** Most of a diff the plugin sends; beyond it, whole files are left out and `truncated` set. */
export const MAX_DIFF_BYTES = 2 * 1024 * 1024;

/** The session's changes: its working tree against where its branch left the default branch. */
export const ChangesReport = z.object({
  sessionId: z.string().min(1),
  at: z.number().int().positive(),
  /** What the diff is against, e.g. `origin/main`, or `HEAD` for uncommitted changes only. */
  base: z.string().max(200),
  /** A unified diff, as `git diff` prints it. */
  diff: z.string().max(MAX_DIFF_BYTES),
  truncated: z.boolean(),
});
export type ChangesReport = z.infer<typeof ChangesReport>;

/** A prompt typed in the dashboard, for the session's plugin to submit. */
export const PromptRequest = z.object({ text: z.string().trim().min(1).max(20_000) });
export type PromptRequest = z.infer<typeof PromptRequest>;

/** Server-sent events on `GET /api/stream`. */
export type StreamEvent =
  | { type: 'snapshot'; sessions: Session[] }
  | { type: 'session'; session: Session }
  | { type: 'messages'; sessionId: string; items: ConversationItem[] }
  /** The session's diff changed; fetch it from `/api/sessions/:id/changes`. */
  | { type: 'changes'; sessionId: string }
  /** New GitHub data; fetch it from `/api/github`. */
  | { type: 'github' };

/** A signed-in person, as the dashboard shows them. */
export const User = z.object({
  login: z.string(),
  name: z.string().optional(),
  avatarUrl: z.string().optional(),
});
export type User = z.infer<typeof User>;

/** `GET /api/auth`: whether this browser is signed in, and as whom. */
export const AuthStatus = z.object({
  signedIn: z.boolean(),
  user: User.optional(),
  /** False only in local dev with no GitHub app configured, where everything is open. */
  required: z.boolean(),
});
export type AuthStatus = z.infer<typeof AuthStatus>;

// Linking a machine: its plugin starts a link and shows the code; the person enters the code at
// /link while signed in; the plugin's poll then gets that machine's own token.

/** `POST /api/devices/start`, from the plugin. */
export const DeviceStartRequest = z.object({ name: z.string().trim().min(1).max(100) });
export type DeviceStartRequest = z.infer<typeof DeviceStartRequest>;

export const DeviceStart = z.object({
  /** Secret: only the plugin that started the link holds it. */
  deviceCode: z.string(),
  /** What the person types at `verificationUri`, e.g. `WXYZ-4821`. */
  userCode: z.string(),
  verificationUri: z.string(),
  /** `verificationUri` with the user code filled in, so the person only has to open it. */
  verificationUriComplete: z.string(),
  /** Seconds until the codes expire. */
  expiresIn: z.number().int().positive(),
  /** Seconds to wait between polls. */
  interval: z.number().int().positive(),
});
export type DeviceStart = z.infer<typeof DeviceStart>;

/** `POST /api/devices/token`, the plugin's poll. */
export const DeviceTokenRequest = z.object({ deviceCode: z.string().min(1).max(200) });
export type DeviceTokenRequest = z.infer<typeof DeviceTokenRequest>;

export const DeviceToken = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('expired') }),
  /** Sent once: the machine's token and the account it now reports to. */
  z.object({ status: z.literal('linked'), token: z.string(), login: z.string() }),
]);
export type DeviceToken = z.infer<typeof DeviceToken>;

/** `POST /api/devices/approve`, from the signed-in dashboard. */
export const DeviceApproveRequest = z.object({ userCode: z.string().trim().min(1).max(20) });
export type DeviceApproveRequest = z.infer<typeof DeviceApproveRequest>;

/** `GET /api/devices/pending?code=`: the machine asking to be linked with that code. */
export const PendingDevice = z.object({
  name: z.string(),
  /** When the machine started the link. */
  requestedAt: z.iso.datetime(),
});
export type PendingDevice = z.infer<typeof PendingDevice>;

/** A linked machine, as `GET /api/devices` lists it. */
export const Device = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
});
export type Device = z.infer<typeof Device>;

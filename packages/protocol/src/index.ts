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
  updatedAt: z.iso.datetime(),
});
export type Session = z.infer<typeof Session>;

/**
 * What the plugin sends on each hook event. Fields left out keep their last value; `title` is
 * only taken from the first report that has one. A report older than the last one applied is
 * dropped.
 */
export const SessionReport = z.object({
  sessionId: z.string().min(1),
  /** When the hook fired, ms since epoch. Hooks run async, so reports can arrive out of order. */
  at: z.number().int().positive(),
  state: SessionState,
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
});
export type SessionReport = z.infer<typeof SessionReport>;

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
  }),
  z.object({
    ...itemBase,
    kind: z.literal('tool_result'),
    toolUseId: z.string().max(200),
    isError: z.boolean(),
    text: z.string().max(5_000),
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
  | { type: 'changes'; sessionId: string };

/** `POST /api/login`: the shared token, pasted into the dashboard's sign-in screen. */
export const LoginRequest = z.object({ token: z.string().min(1).max(1_000) });
export type LoginRequest = z.infer<typeof LoginRequest>;

/** `GET /api/auth`: whether the server needs a token, and whether this request carried one. */
export const AuthStatus = z.object({ required: z.boolean(), signedIn: z.boolean() });
export type AuthStatus = z.infer<typeof AuthStatus>;

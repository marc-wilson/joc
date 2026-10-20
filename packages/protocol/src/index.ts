import { z } from 'zod';
import type { Prefs } from './prefs.ts';

export * from './prefs.ts';

export const SessionState = z.enum(['working', 'background', 'needs', 'idle', 'offline']);
export type SessionState = z.infer<typeof SessionState>;

export const CIStatus = z.enum(['pass', 'fail', 'pending', 'skipped']);
export type CIStatus = z.infer<typeof CIStatus>;

// Answering from the dashboard. When a session asks a question (AskUserQuestion) or wants
// permission for a tool call, its plugin tells the server what it waits on and polls for an
// answer while Claude Code's own prompt stays up. Whichever answers first wins: the terminal, or
// a person in the dashboard. An answer that comes too late is dropped. A permission answer from
// the dashboard is only ever "allow once" or "deny": it never adds a rule.

/** Names one wait: made by the plugin, fresh for every question or permission request. */
export const WaitingId = z.string().regex(/^[\w-]{8,64}$/);
export type WaitingId = z.infer<typeof WaitingId>;

/** One of the questions a session asks, as Claude Code's AskUserQuestion tool puts it. */
export const WaitingQuestion = z.object({
  question: z.string().min(1).max(2000),
  /** A short label for it, e.g. `Auth method`. */
  header: z.string().max(100).optional(),
  /** Empty for a question answered in words alone. */
  options: z
    .array(
      z.object({ label: z.string().min(1).max(200), description: z.string().max(500).optional() }),
    )
    .max(10),
  multiSelect: z.boolean(),
});
export type WaitingQuestion = z.infer<typeof WaitingQuestion>;

/** What a session waits on you for, as its plugin reports it. */
export const Waiting = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('question'),
    id: WaitingId,
    questions: z.array(WaitingQuestion).min(1).max(4),
  }),
  z.object({
    kind: z.literal('permission'),
    id: WaitingId,
    /** The tool, as Claude Code names it: `Bash`, `Edit`, `mcp__server__tool`. */
    tool: z.string().min(1).max(200),
    /** What the call does, one line: a command, a path, a URL. */
    summary: z.string().max(500),
    /** What Claude said the call is for, when it said. */
    description: z.string().max(500).optional(),
  }),
]);
export type Waiting = z.infer<typeof Waiting>;

/** Who answered a wait: from the dashboard, or in Claude Code itself. */
export const AnsweredBy = z.enum(['joc', 'claude-code']);
export type AnsweredBy = z.infer<typeof AnsweredBy>;

/** An answer from the dashboard. */
export const Answer = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('question'),
    /** Each question's answer by its text: an option's label, labels joined by `, `, or words. */
    answers: z.record(z.string().max(2000), z.string().trim().min(1).max(5000)),
  }),
  /** Allow this one call, or deny it. Never a rule for later calls. */
  z.object({ kind: z.literal('permission'), allow: z.boolean() }),
]);
export type Answer = z.infer<typeof Answer>;

/** `POST /api/sessions/:id/answers`, from the dashboard. */
export const AnswerRequest = z.object({ waitingId: WaitingId, answer: Answer });
export type AnswerRequest = z.infer<typeof AnswerRequest>;

/** Why an answer was refused (409): the wait is over, and who ended it if anyone did. */
export const AnswerRefused = z.object({
  error: z.string(),
  answeredBy: AnsweredBy.optional(),
});
export type AnswerRefused = z.infer<typeof AnswerRefused>;

/** The longest a plugin's answer poll is held open. */
export const MAX_ANSWER_WAIT_MS = 10_000;

/** `POST /api/sessions/:id/answers/claim`, the plugin's: held open until an answer or `waitMs`. */
export const AnswerClaim = z.object({
  waitingId: WaitingId,
  waitMs: z.number().int().min(0).max(MAX_ANSWER_WAIT_MS).optional(),
});
export type AnswerClaim = z.infer<typeof AnswerClaim>;

/** The claim's reply: the answer, taken once, or `null` when none came in time. */
export const ClaimedAnswer = z.object({ answer: Answer.nullable() });
export type ClaimedAnswer = z.infer<typeof ClaimedAnswer>;

/**
 * `POST /api/sessions/:id/waiting/:waitingId/done`, the plugin's: the wait is over. `by` says
 * who answered; left out, the plugin stopped watching and Claude Code still asks.
 */
export const WaitingDone = z.object({ by: AnsweredBy.optional() });
export type WaitingDone = z.infer<typeof WaitingDone>;

/** Whether `answer` answers `waiting`: the same kind, and for questions every one of them. */
export function answerFits(waiting: Waiting, answer: Answer): boolean {
  if (waiting.kind === 'permission') return answer.kind === 'permission';
  if (answer.kind !== 'question') return false;
  const asked = waiting.questions.map((q) => q.question);
  const given = Object.keys(answer.answers);
  return given.length === asked.length && asked.every((q) => given.includes(q));
}

/** The most background tasks a report carries. */
export const MAX_RUNNING_TASKS = 50;

/**
 * One piece of background work Claude Code says is in flight in a session: a shell, a subagent,
 * a teammate, a monitor, a workflow, or a scheduled wakeup (`cron`). From the `background_tasks`
 * and `session_crons` of its Stop hook. Only `id` and `type` are always there.
 */
export const RunningTask = z.object({
  /** Claude Code's id: a shell's task id, an agent's id, a cron's id. */
  id: z.string().min(1).max(200),
  /** Claude Code's label for the kind: `shell`, `subagent`, `monitor`, `workflow`, `cron`, ... */
  type: z.string().min(1).max(50),
  status: z.string().max(50).optional(),
  description: z.string().max(1000).optional(),
  /** A shell's command line. */
  command: z.string().max(1000).optional(),
  /** A subagent's type, e.g. `Explore`. */
  agentType: z.string().max(100).optional(),
  /** A monitor's MCP server and tool. */
  server: z.string().max(200).optional(),
  tool: z.string().max(200).optional(),
  /** A workflow's name. */
  name: z.string().max(200).optional(),
  /** A cron's schedule, e.g. `0 9 * * 1-5`. */
  schedule: z.string().max(100).optional(),
});
export type RunningTask = z.infer<typeof RunningTask>;

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
  /**
   * The JOC plugin version this session runs: the copy it loaded, which stays until the session
   * reloads plugins. Unset when its plugin is too old to say.
   */
  plugin: z.string().optional(),
  /** What it waits on you for, while its plugin can take an answer from the dashboard. */
  waiting: Waiting.optional(),
  /** The last wait that ended, and who answered it. */
  answered: z.object({ id: z.string(), by: AnsweredBy }).optional(),
  /**
   * What Claude Code last said is running in the background, and when it said so. The truth for
   * what runs; unset until a plugin that sends it reports a Stop.
   */
  background: z
    .object({ at: z.iso.datetime(), tasks: z.array(RunningTask).max(MAX_RUNNING_TASKS) })
    .optional(),
  startedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Session = z.infer<typeof Session>;

/** A past session for the History page: a session plus how many messages it has. */
export const HistorySession = Session.extend({ messages: z.number().int().nonnegative() });
export type HistorySession = z.infer<typeof HistorySession>;

/** How long a session stays on the live list after it last reported. `never` keeps it there. */
export const DropAfter = z.enum(['1h', '1d', '1w', '30d', 'never']);
export type DropAfter = z.infer<typeof DropAfter>;

/** The milliseconds each `DropAfter` stands for; `never` has none. */
export const DROP_AFTER_MS: Record<Exclude<DropAfter, 'never'>, number> = {
  '1h': 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '1w': 7 * 24 * 60 * 60_000,
  '30d': 30 * 24 * 60 * 60_000,
};

/**
 * Which sessions the live list keeps, per owner (`GET`/`PUT /api/settings/sessions`). A session
 * that dropped off stays in the history.
 */
export const SessionSettings = z.object({
  /** A session that went quiet without ending: the machine asleep, or Claude Code killed. */
  quiet: DropAfter,
  /** A session that ended (`offline`, from Claude Code's SessionEnd). */
  ended: DropAfter,
});
export type SessionSettings = z.infer<typeof SessionSettings>;

export const DEFAULT_SESSION_SETTINGS: SessionSettings = { quiet: '1w', ended: '1d' };

/** A live session syncs every 30s, so this much silence means it stopped reporting. */
export const QUIET_AFTER_MS = 2 * 60_000;

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
  /**
   * Everything Claude Code says is running in the background, as of `at`: sent on a Stop (empty
   * when nothing is) and as empty when the session ends. Left out, the stored list stays.
   */
  background: z.array(RunningTask).max(MAX_RUNNING_TASKS).optional(),
});
export type SessionReport = z.infer<typeof SessionReport>;

/** The most changed files a pull request lists; `changedFiles` says how many there are in all. */
export const MAX_PR_FILES = 100;

/** A file a pull request changes, as GitHub lists it. */
export const PullRequestFile = z.object({
  path: z.string().max(1000),
  status: z.enum(['added', 'modified', 'deleted', 'renamed']),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export type PullRequestFile = z.infer<typeof PullRequestFile>;

/** The most checks a pull request lists, from its last commit. */
export const MAX_PR_CHECKS = 50;

/** One CI check on a pull request's last commit: a check run or a commit status. */
export const PullRequestCheck = z.object({
  name: z.string().max(200),
  status: CIStatus,
  /** How long it ran, once it finished. */
  seconds: z.number().int().nonnegative().optional(),
});
export type PullRequestCheck = z.infer<typeof PullRequestCheck>;

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
  /** Its last commit's first MAX_PR_CHECKS checks. Plugins before 0.8.1 leave them out. */
  checks: z.array(PullRequestCheck).max(MAX_PR_CHECKS).optional(),
  /** The branch it merges into. Plugins before 0.6.0 leave it out, and the files too. */
  base: z.string().max(300).optional(),
  /** Its first MAX_PR_FILES changed files, in GitHub's order. */
  files: z.array(PullRequestFile).max(MAX_PR_FILES).optional(),
  /** How many files it changes in all. */
  changedFiles: z.number().int().nonnegative().optional(),
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

/**
 * Why a GitHub thread wants the person, as the plugin judges it: the few that are worth
 * interrupting them for. Everything else waits in the Inbox.
 */
export const NotificationAlert = z.enum(['review', 'mention', 'ci-failed']);
export type NotificationAlert = z.infer<typeof NotificationAlert>;

/** Most unread threads the plugin reads and sends: the newest, as GitHub orders them. */
export const MAX_NOTIFICATIONS = 200;

/** One unread thread from the person's GitHub notifications, as the plugin reads it via `gh`. */
export const GitHubNotification = z.object({
  /** GitHub's thread id, for marking it read. */
  id: z.string().regex(/^\d+$/).max(30),
  /**
   * GitHub's reason: `review_requested`, `mention`, `team_mention`, `comment`, `assign`,
   * `author`, `ci_activity`, `state_change`, `subscribed`, and others GitHub may add.
   */
  reason: z.string().min(1).max(50),
  title: z.string().max(500),
  /** GitHub's subject type: `PullRequest`, `Issue`, `CheckSuite`, `Discussion`, `Release`, ... */
  type: z.string().min(1).max(50),
  /** `owner/name`, matching Session.repo. */
  repo: z.string().max(200),
  /** The thread's page on GitHub. */
  url: z.url(),
  updatedAt: z.iso.datetime(),
  /** The pull request or issue number, when the thread is one. */
  number: z.number().int().positive().optional(),
  /** For a CI thread, the branch its run was on. */
  branch: z.string().max(300).optional(),
  alert: NotificationAlert.optional(),
});
export type GitHubNotification = z.infer<typeof GitHubNotification>;

/** What the plugin reads from the person's GitHub notifications, when the feed changed. */
export const NotificationsReport = z.object({
  at: z.number().int().positive(),
  status: GitHubReport.shape.status,
  threads: z.array(GitHubNotification).max(MAX_NOTIFICATIONS),
  /** True when GitHub has more unread threads than were read. */
  more: z.boolean(),
});
export type NotificationsReport = z.infer<typeof NotificationsReport>;

/**
 * `GET /api/notifications`: the unread threads, or `none` before any machine has sent them.
 * Threads the person marked read leave the list at once, before GitHub hears of it.
 */
export const NotificationsSnapshot = z.discriminatedUnion('state', [
  z.object({ state: z.literal('none') }),
  z.object({
    state: z.literal('reported'),
    status: GitHubReport.shape.status,
    threads: z.array(GitHubNotification),
    more: z.boolean(),
    updatedAt: z.iso.datetime(),
  }),
]);
export type NotificationsSnapshot = z.infer<typeof NotificationsSnapshot>;

/** `POST /api/notifications/read`, from the dashboard: mark these threads read on GitHub. */
export const MarkReadRequest = z.object({
  ids: z.array(GitHubNotification.shape.id).min(1).max(MAX_NOTIFICATIONS),
});
export type MarkReadRequest = z.infer<typeof MarkReadRequest>;

/** `POST /api/notifications/reads/claim`, the plugin's: the threads to mark read on GitHub. */
export const ReadsClaim = z.object({ ids: z.array(GitHubNotification.shape.id) });
export type ReadsClaim = z.infer<typeof ReadsClaim>;

// Alerts: JOC's own record of what involved the person, kept on the server so they can look back
// on what they missed. The server raises them from what the plugin reports: a session that went
// to `needs`, a turn that finished, a pull request newly asking for their review.

/** What an alert is about. */
export const AlertKind = z.enum(['needs', 'finished', 'review']);
export type AlertKind = z.infer<typeof AlertKind>;

/** Most alerts kept per person; older ones go first. */
export const MAX_ALERTS = 200;

/** An alert's id, made by the server. */
export const AlertId = z.uuid();

/** One alert, as `GET /api/alerts` lists them, newest first. */
export const Alert = z.object({
  id: AlertId,
  kind: AlertKind,
  /** The session's title, or the pull request's. */
  title: z.string(),
  /**
   * One line more: what the session said it needs, how its turn ended, or (for `review`) the
   * pull request's author.
   */
  detail: z.string().optional(),
  /** `owner/name`, matching Session.repo. */
  repo: z.string(),
  /** The session it's about, for `needs` and `finished`. */
  sessionId: z.string().optional(),
  /** The pull request, for `review`. */
  number: z.number().int().positive().optional(),
  url: z.url().optional(),
  at: z.iso.datetime(),
  read: z.boolean(),
});
export type Alert = z.infer<typeof Alert>;

/** `POST /api/alerts/read` and `/api/alerts/clear`, from the dashboard. */
export const AlertIdsRequest = z.object({ ids: z.array(AlertId).min(1).max(MAX_ALERTS) });
export type AlertIdsRequest = z.infer<typeof AlertIdsRequest>;

/** How a background task (shell command or subagent) ended. */
export const TaskStatus = z.enum(['completed', 'failed', 'killed']);
export type TaskStatus = z.infer<typeof TaskStatus>;

/** The image formats JOC takes, told apart by their bytes. Never SVG: it can carry script. */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export const ImageType = z.enum(IMAGE_TYPES);
export type ImageType = z.infer<typeof ImageType>;

/** The largest image JOC stores. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** The most images one message or prompt carries. */
export const MAX_IMAGES_PER_MESSAGE = 10;

/** An image's id: the SHA-256 of its bytes, in hex, worked out by the server. */
export const ImageId = z.string().regex(/^[0-9a-f]{64}$/);
export type ImageId = z.infer<typeof ImageId>;

/** A stored image, as `POST /api/images` answers and messages and prompts refer to it. */
export const ImageRef = z.object({
  id: ImageId,
  type: ImageType,
  /** Its size, when known. */
  bytes: z.number().int().positive().max(MAX_IMAGE_BYTES).optional(),
});
export type ImageRef = z.infer<typeof ImageRef>;

const itemBase = {
  id: z.string().min(1).max(200),
  at: z.iso.datetime(),
  /**
   * Set on a step a subagent took, from its own transcript: the `toolUseId` of the call that
   * started it. Such items are the subagent's, not the session's conversation, and are served by
   * `GET /api/sessions/:id/tasks/:task/messages` instead.
   */
  task: z.string().min(1).max(200).optional(),
};

/** One entry in a session's conversation, normalized from its transcript by the plugin. */
export const ConversationItem = z.discriminatedUnion('kind', [
  z.object({
    ...itemBase,
    kind: z.literal('user'),
    text: z.string().max(20_000),
    /**
     * Set when the prompt was a slash command, e.g. `review`. Plugins before 0.3.0 sent commands
     * this way; newer ones send a `command` item instead.
     */
    command: z.string().max(100).optional(),
    /** Images sent with the prompt, served by `GET /api/images/:id`. */
    images: z.array(ImageRef).max(MAX_IMAGES_PER_MESSAGE).optional(),
  }),
  /** A slash command run in the session, typed there or sent from the dashboard. */
  z.object({
    ...itemBase,
    kind: z.literal('command'),
    /** Without its slash, e.g. `compact` or `harbor:deploy`. */
    name: z.string().min(1).max(100),
    /** Everything after the name; empty when there was nothing. */
    args: z.string().max(20_000),
  }),
  /** What a command printed, or why it couldn't run. Shown with the command it belongs to. */
  z.object({
    ...itemBase,
    kind: z.literal('command_output'),
    /** The id of its `command` item, when the transcript says. */
    commandId: z.string().max(200).optional(),
    text: z.string().max(5_000),
    isError: z.boolean(),
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
    /** What a subagent was asked: its whole prompt. */
    prompt: z.string().max(20_000).optional(),
    /** A background shell's whole command, when it runs past the one line in `summary`. */
    command: z.string().max(5_000).optional(),
  }),
  z.object({
    ...itemBase,
    kind: z.literal('tool_result'),
    toolUseId: z.string().max(200),
    isError: z.boolean(),
    /** Up to 5,000 characters; a subagent's final report can run to 50,000. */
    text: z.string().max(50_000),
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
    /** A background subagent's final report. */
    result: z.string().max(50_000).optional(),
    /** The end of what a background shell printed. */
    output: z.string().max(20_000).optional(),
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

/** A prompt typed in the dashboard, for the session's plugin to submit: text, images or both. */
export const PromptRequest = z
  .object({
    text: z.string().trim().max(20_000),
    /** Images uploaded first with `POST /api/images`. */
    images: z.array(ImageId).max(MAX_IMAGES_PER_MESSAGE).optional(),
  })
  .refine((p) => p.text !== '' || !!p.images?.length, { message: 'A prompt needs text or images' });
export type PromptRequest = z.infer<typeof PromptRequest>;

/** A queued prompt, as `POST /api/sessions/:id/prompts/claim` hands it to the plugin. */
export const ClaimedPrompt = z.object({
  id: z.string(),
  text: z.string(),
  images: z.array(ImageRef),
});
export type ClaimedPrompt = z.infer<typeof ClaimedPrompt>;

// Starting a new Claude Code session from the dashboard, such as one that reviews a pull
// request. Nothing reaches into the machine: a session already running on the repo takes the
// launch on its next poll and starts `claude --bg` in its own folder. The new session is a real
// one; its plugin reports it like any other. The server only queues and records how it went.

/** The command Claude's standard review runs, given the PR number. */
export const STANDARD_REVIEW = '/code-review';

/**
 * How the person reviews a pull request: a skill or command to run (`/prep-pr`), or a prompt of
 * their own, which can be long. Empty means Claude's standard review.
 */
export const ReviewInstructions = z.string().trim().max(20_000);
export type ReviewInstructions = z.infer<typeof ReviewInstructions>;

/**
 * The prompt a review starts with. With no instructions, Claude's standard review of the PR
 * number. Otherwise the instructions with `{pr}` replaced by the number and `{url}` by the PR's
 * address; with neither, the address goes after a command, or on its own line after a prompt,
 * so Claude always knows which PR.
 */
export function reviewPrompt(pr: { number: number; url: string }, instructions?: string): string {
  const own = instructions?.trim();
  if (!own) return `${STANDARD_REVIEW} ${pr.number}`;
  if (/\{pr\}|\{url\}/.test(own)) {
    return own.replaceAll('{pr}', String(pr.number)).replaceAll('{url}', pr.url);
  }
  const command = own.startsWith('/') && !own.includes('\n');
  return command ? `${own} ${pr.url}` : `${own}\n\nThe pull request: ${pr.url}`;
}

/** `GET` and `PUT /api/settings/review`: the person's review instructions, if they set any. */
export const ReviewSettings = z.object({ instructions: ReviewInstructions.optional() });
export type ReviewSettings = z.infer<typeof ReviewSettings>;

/** The pull request a new session reviews. */
export const LaunchReview = z.object({
  repo: z.string().min(1).max(200),
  number: z.number().int().positive(),
  url: z.url().max(500),
});
export type LaunchReview = z.infer<typeof LaunchReview>;

/**
 * `POST /api/launches`, from the dashboard: start a new session beside a running one, in its
 * folder. With `review`, it reviews that PR with the person's review instructions (the session
 * must be on the PR's repo); otherwise it starts with `prompt`, or with none.
 */
export const LaunchRequest = z.object({
  /** The live session whose plugin starts the new one. */
  from: z.string().min(1).max(200),
  prompt: z.string().trim().max(20_000).optional(),
  review: LaunchReview.optional(),
});
export type LaunchRequest = z.infer<typeof LaunchRequest>;

/**
 * - `starting`: waiting for the session on the repo to start it.
 * - `started`: running; `sessionId` names it once the plugin found its id.
 * - `failed`: it couldn't be started; `detail` says why.
 */
export const LaunchStatus = z.enum(['starting', 'started', 'failed']);
export type LaunchStatus = z.infer<typeof LaunchStatus>;

/** A new session asked for from the dashboard, as `GET /api/launches` lists them. */
export const Launch = z.object({
  id: z.string(),
  /** The repo of the session it starts from, if it has one. */
  repo: z.string().optional(),
  /** The session whose plugin starts it. */
  from: z.string(),
  /** The PR it reviews. */
  review: LaunchReview.optional(),
  prompt: z.string().optional(),
  status: LaunchStatus,
  /** The new session, once started. */
  sessionId: z.string().optional(),
  detail: z.string().optional(),
  createdAt: z.iso.datetime(),
});
export type Launch = z.infer<typeof Launch>;

/**
 * A new session to start, as `POST /api/sessions/:id/launches/claim` hands it to that session's
 * plugin, which runs `claude --bg [--name <name>] [-- <prompt>]` in its folder.
 */
export const ClaimedLaunch = z.object({
  id: z.string(),
  name: z.string().optional(),
  prompt: z.string().optional(),
});
export type ClaimedLaunch = z.infer<typeof ClaimedLaunch>;

/** `POST /api/launches/:id/result`, from the plugin: whether the new session started. */
export const LaunchResult = z.object({
  ok: z.boolean(),
  /** The new session's id, as `claude agents` lists it. */
  sessionId: z.uuid().optional(),
  /** Why it didn't start, one line. */
  detail: z.string().max(500).optional(),
});
export type LaunchResult = z.infer<typeof LaunchResult>;

/** Server-sent events on `GET /api/stream`. */
export type StreamEvent =
  | { type: 'snapshot'; sessions: Session[] }
  | { type: 'session'; session: Session }
  | { type: 'messages'; sessionId: string; items: ConversationItem[] }
  /** The session's diff changed; fetch it from `/api/sessions/:id/changes`. */
  | { type: 'changes'; sessionId: string }
  /** New GitHub data; fetch it from `/api/github`. */
  | { type: 'github' }
  /** The unread GitHub notifications changed; fetch them from `/api/notifications`. */
  | { type: 'notifications' }
  /** The person's alerts changed; fetch them from `/api/alerts`. */
  | { type: 'alerts' }
  /** A new session was asked for or changed; fetch them from `/api/launches`. */
  | { type: 'launches' }
  /** The person's preferences changed, maybe in another tab. */
  | { type: 'prefs'; prefs: Prefs };

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

/** A live session on a machine that still runs a plugin copy older than the one JOC expects. */
export const StaleSession = z.object({
  id: z.string(),
  title: z.string().optional(),
  repo: z.string(),
  state: SessionState,
  /** The plugin version the session loaded. */
  plugin: z.string(),
});
export type StaleSession = z.infer<typeof StaleSession>;

/** A linked machine, as `GET /api/devices` lists it. */
export const Device = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  /**
   * The plugin version the machine's latest request ran. Any of its open sessions may have sent
   * it, so it can be an old copy a session hasn't reloaded. Unset when it sent none or hasn't
   * been seen.
   */
  plugin: z.string().optional(),
  /** The plugin version installed on the machine; unset when its plugins are too old to say. */
  installed: z.string().optional(),
  /**
   * The machine needs the update command: its installed plugin is behind the one JOC expects.
   * When it doesn't say what's installed, the plugin its latest request ran is (or is too old to
   * say its version).
   */
  outdated: z.boolean(),
  /** Its live sessions that still run an older plugin copy: `/reload-plugins` in each fixes it. */
  stale: z.array(StaleSession),
});
export type Device = z.infer<typeof Device>;

// Plugin versions. The plugin names its own version (apps/plugin/.claude-plugin/plugin.json) in
// the `x-joc-plugin` header of every request: the copy the session loaded. From 0.7.1 its hooks
// also name the version installed on the machine (`joc@joc` in Claude Code's
// installed_plugins.json) in `x-joc-plugin-installed`. When the running version is behind the
// one the server ships with, the answer carries `x-joc-plugin-latest` with that version, so the
// plugin can say so.

/** A plugin's `version`: `major.minor.patch`, with an optional `-prerelease`. */
export const PluginVersion = z
  .string()
  .max(40)
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
export type PluginVersion = z.infer<typeof PluginVersion>;

/** `GET /api/version`: what this server expects and serves. */
export const ServerVersion = z.object({
  /** The plugin version this server ships with: the one every machine should run. */
  plugin: PluginVersion,
  /** Names the dashboard build the server serves; changes when it's deployed. Unset in dev. */
  build: z.string().optional(),
});
export type ServerVersion = z.infer<typeof ServerVersion>;

// What went wrong in a machine's plugin. The plugin never shows a failure in the session; it
// keeps a short local record (`/joc-status` reads it) and sends it here once the server answers.

/**
 * - `unreachable`: no answer from the server (down, offline, timed out).
 * - `unauthorized`: the server refused the machine's token (revoked, or never linked).
 * - `rejected`: the server refused one of the plugin's own requests (4xx), e.g. an invalid report.
 * - `server-error`: the server failed on a request (5xx).
 * - `crash`: the plugin itself failed.
 */
export const ProblemKind = z.enum([
  'unreachable',
  'unauthorized',
  'rejected',
  'server-error',
  'crash',
]);
export type ProblemKind = z.infer<typeof ProblemKind>;

/** One problem, folded: the same kind in the same place counts up instead of repeating. */
export const PluginProblem = z.object({
  kind: ProblemKind,
  /**
   * What failed: the server's address for `unreachable` and `unauthorized`, the API path for
   * `rejected` and `server-error` (`/api/messages`), the part of the plugin for `crash` (`hook`,
   * `module`).
   */
  where: z.string().min(1).max(100),
  /** The latest occurrence, one line: the error's message or what the server said. */
  detail: z.string().max(500),
  /** When this run of it started and last happened, ms since epoch. */
  firstAt: z.number().int().positive(),
  lastAt: z.number().int().positive(),
  count: z.number().int().positive(),
  /** When a later attempt worked again; unset while it's still happening. */
  resolvedAt: z.number().int().positive().optional(),
});
export type PluginProblem = z.infer<typeof PluginProblem>;

/** `POST /api/problems`, from a machine's plugin. */
export const ProblemsReport = z.object({
  /** The machine's host name, as session reports carry it. */
  machine: z.string().trim().min(1).max(100),
  problems: z.array(PluginProblem).min(1).max(20),
});
export type ProblemsReport = z.infer<typeof ProblemsReport>;

/** A machine's problem, as `GET /api/problems` lists it for the Machines page. */
export const MachineProblem = z.object({
  machine: z.string(),
  kind: ProblemKind,
  where: z.string(),
  detail: z.string(),
  firstAt: z.iso.datetime(),
  lastAt: z.iso.datetime(),
  count: z.number().int().positive(),
  resolvedAt: z.iso.datetime().optional(),
});
export type MachineProblem = z.infer<typeof MachineProblem>;

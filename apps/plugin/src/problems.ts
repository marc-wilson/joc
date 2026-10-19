// The plugin's record of its own failures. The plugin never shows an error in a session, so
// instead it keeps a short, capped log in ~/.claude/joc/status.json: `/joc-status` reads it, and
// hook.ts sends it to the server once the server answers again, for the Machines page.
//
// Pure functions over that file's content, shared by hook.ts (Node) and register.ts (the engine,
// no Node): each reads and writes the file its own way. No runtime imports, so both can load it.
import type { PluginProblem, ProblemKind } from '@joc/protocol';

/** Under the home folder, next to credentials.json. */
export const STATUS_PATH = '.claude/joc/status.json';
/** Problems kept, newest last; older ones drop off. */
const MAX_PROBLEMS = 20;
const MAX_DETAIL = 500;
const MAX_WHERE = 100;
/** How often `lastOkAt` is rewritten when nothing else changed, so a busy session isn't a write
 * per hook. */
const OK_EVERY_MS = 60_000;
/** How often problems go to the server, at most. */
const SEND_EVERY_MS = 60_000;
/** Problems about sending problems aren't sent: they'd only fail the same way. */
export const PROBLEMS_PATH = '/api/problems';

export interface LocalProblem extends PluginProblem {
  /** The server has this version of it. */
  sent?: boolean;
}

export interface PluginStatus {
  /** When the server last accepted a request from this machine, ms since epoch. */
  lastOkAt?: number;
  /** When problems last went to the server. */
  sentAt?: number;
  problems: LocalProblem[];
}

/** How one attempt went. `where` follows PluginProblem's `where`; a server path starts with `/`. */
export type Outcome =
  | { ok: true; where: string; at: number }
  | { ok: false; kind: ProblemKind; where: string; detail: string; at: number };

/** Every kind, with how `/joc-status` leads its line. */
const KIND_LABEL: Record<ProblemKind, string> = {
  unreachable: "Couldn't reach",
  unauthorized: 'Token refused by',
  rejected: 'Request refused:',
  'server-error': 'Server failed on',
  crash: 'Plugin error in',
};

const isKind = (value: unknown): value is ProblemKind =>
  typeof value === 'string' && Object.hasOwn(KIND_LABEL, value);

const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

function entries(value: unknown): [string, unknown][] {
  return value && typeof value === 'object' ? Object.entries(value) : [];
}

function toProblem(value: unknown): LocalProblem | undefined {
  const fields = new Map(entries(value));
  const kind = fields.get('kind');
  const where = fields.get('where');
  const detail = fields.get('detail');
  const firstAt = fields.get('firstAt');
  const lastAt = fields.get('lastAt');
  const count = fields.get('count');
  const resolvedAt = fields.get('resolvedAt');
  if (!isKind(kind) || typeof where !== 'string' || !where || typeof detail !== 'string') {
    return undefined;
  }
  if (!isTime(firstAt) || !isTime(lastAt) || !isTime(count)) return undefined;
  return {
    kind,
    where: where.slice(0, MAX_WHERE),
    detail: detail.slice(0, MAX_DETAIL),
    firstAt,
    lastAt,
    count,
    ...(isTime(resolvedAt) ? { resolvedAt } : {}),
    ...(fields.get('sent') === true ? { sent: true } : {}),
  };
}

/** The status file's content; a missing or broken file reads as an empty record. */
export function parseStatus(text: string | undefined): PluginStatus {
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    // A file cut short by a crash mid-write: start again rather than never record anything.
    parsed = undefined;
  }
  const fields = new Map(entries(parsed));
  const list = fields.get('problems');
  const lastOkAt = fields.get('lastOkAt');
  const sentAt = fields.get('sentAt');
  return {
    ...(isTime(lastOkAt) ? { lastOkAt } : {}),
    ...(isTime(sentAt) ? { sentAt } : {}),
    problems: (Array.isArray(list) ? list : []).flatMap((p) => {
      const problem = toProblem(p);
      return problem ? [problem] : [];
    }),
  };
}

export const formatStatus = (status: PluginStatus) => `${JSON.stringify(status, null, 2)}\n`;

/** Problems any accepted request proves over: the server answers and takes the token. */
const anyRequestFixes = (kind: ProblemKind) => kind === 'unreachable' || kind === 'unauthorized';

/** The problem as the server should see it: without the local `sent` mark. */
const unsent = ({ sent: _, ...problem }: LocalProblem): PluginProblem => problem;

function apply(status: PluginStatus, outcome: Outcome): PluginStatus {
  if (outcome.ok) {
    const fromServer = outcome.where.startsWith('/');
    const problems = status.problems.map((p) =>
      !p.resolvedAt && (p.where === outcome.where || (fromServer && anyRequestFixes(p.kind)))
        ? { ...unsent(p), resolvedAt: outcome.at }
        : p,
    );
    const { lastOkAt } = status;
    const stale = fromServer && (!lastOkAt || outcome.at - lastOkAt >= OK_EVERY_MS);
    return { ...status, ...(stale ? { lastOkAt: outcome.at } : {}), problems };
  }
  const { kind, at } = outcome;
  const where = outcome.where.slice(0, MAX_WHERE);
  const detail = outcome.detail.slice(0, MAX_DETAIL);
  const same = status.problems.find((p) => p.kind === kind && p.where === where);
  // A problem that had cleared up starts a new run rather than adding to the old one.
  const problem: LocalProblem =
    same && !same.resolvedAt
      ? { ...unsent(same), detail, lastAt: Math.max(same.lastAt, at), count: same.count + 1 }
      : { kind, where, detail, firstAt: at, lastAt: at, count: 1 };
  const problems = [...status.problems.filter((p) => p !== same), problem].slice(-MAX_PROBLEMS);
  return { ...status, problems };
}

/** The record after these attempts, in order. */
export function applyOutcomes(status: PluginStatus, outcomes: readonly Outcome[]): PluginStatus {
  return outcomes.reduce(apply, status);
}

/** What the plugin should send the server now: the problems it hasn't got, once a minute. */
export function toSend(status: PluginStatus, now: number): PluginProblem[] {
  if (now - (status.sentAt ?? 0) < SEND_EVERY_MS) return [];
  return status.problems.filter((p) => !p.sent && p.where !== PROBLEMS_PATH).map(unsent);
}

/** Marks what the server accepted, unless a problem changed again since it was read. */
export function markSent(status: PluginStatus, sent: PluginProblem[], now: number): PluginStatus {
  const same = (a: PluginProblem, b: PluginProblem) =>
    a.kind === b.kind &&
    a.where === b.where &&
    a.lastAt === b.lastAt &&
    a.count === b.count &&
    a.resolvedAt === b.resolvedAt;
  return {
    ...status,
    sentAt: now,
    problems: status.problems.map((p) => (sent.some((s) => same(s, p)) ? { ...p, sent: true } : p)),
  };
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL);

/** Where in the plugin an error came from, as `hook.ts:42`: the file name only, no home path. */
function origin(stack: string | undefined): string | undefined {
  const frame = stack?.match(/([\w.-]+\.ts):(\d+)/);
  return frame ? `${frame[1]}:${frame[2]}` : undefined;
}

/** One line for an error: its name and message, the cause a failed fetch hides, and where. */
export function errorDetail(error: unknown): string {
  if (!(error instanceof Error)) return oneLine(String(error));
  const cause = error.cause instanceof Error ? ` (${error.cause.message})` : '';
  const at = origin(error.stack);
  return oneLine(`${error.name}: ${error.message}${cause}${at ? ` at ${at}` : ''}`);
}

/** What the server said when it refused a request: its error text, or the invalid fields. */
function rejection(status: number, body: string): string {
  let error: unknown;
  try {
    error = new Map(entries(JSON.parse(body))).get('error');
  } catch {
    // Not JSON (a proxy's error page, say): the status alone has to do.
    error = undefined;
  }
  if (typeof error === 'string') return oneLine(`HTTP ${status}: ${error}`);
  if (Array.isArray(error)) {
    // zod issues: which fields and why. Never the values sent.
    const issues = error.map((issue) => {
      const fields = new Map(entries(issue));
      const path = fields.get('path');
      const message = fields.get('message');
      const at = Array.isArray(path) && path.length ? `${path.join('.')}: ` : '';
      return `${at}${typeof message === 'string' ? message : 'invalid'}`;
    });
    return oneLine(`HTTP ${status}: ${issues.join('; ')}`);
  }
  return `HTTP ${status}`;
}

/** How a request to `path` on `server` went, from the status and body the server answered. */
export function responseOutcome(
  response: { status: number; body: string },
  path: string,
  server: string,
  at: number,
): Outcome {
  const { status, body } = response;
  if (status >= 200 && status < 400) return { ok: true, where: path, at };
  const detail = rejection(status, body);
  if (status === 401) return { ok: false, kind: 'unauthorized', where: server, detail, at };
  const kind = status >= 500 ? 'server-error' : 'rejected';
  return { ok: false, kind, where: path, detail, at };
}

/**
 * Why `node hook.ts` exited non-zero, which it only does when it can't even load (a syntax
 * error, a missing file): the error line Node printed, and the file and line it named.
 */
export function exitDetail(exitCode: number, stderr: string): string {
  const error = stderr.match(/^\w*(Error|Exception)\b.*$/m)?.[0];
  const at = origin(stderr);
  if (!error) return `node exited with code ${exitCode}`;
  return oneLine(`${error}${at ? ` at ${at}` : ''}`);
}

/** "3m", "2h", "4d": how long ago, for the status text. */
export function age(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** Two lines for `/joc-status`: what, how often and whether it stopped; then the detail. */
export function describeProblem(problem: PluginProblem, now: number): string {
  const times = problem.count === 1 ? 'once' : `${problem.count} times`;
  const over = problem.count > 1 ? ` over ${age(problem.lastAt - problem.firstAt)}` : '';
  const state = problem.resolvedAt
    ? `worked again ${age(now - problem.resolvedAt)} ago`
    : 'still happening';
  return [
    `  ${age(now - problem.lastAt)} ago  ${KIND_LABEL[problem.kind]} ${problem.where}, ${times}${over}, ${state}`,
    `      ${problem.detail}`,
  ].join('\n');
}

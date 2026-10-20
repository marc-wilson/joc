// What a session waits on (a question, a permission request), as the hooks module reports it to
// JOC, and the decision a JOC answer becomes. Dependency-free and Node-free: register.ts runs it.
// The shapes are @joc/protocol's `Waiting` and `Answer`, written out here because the module
// can't load zod; types only cross.
import type { Answer, Waiting, WaitingQuestion } from '@joc/protocol';

/** How long the server holds an answer poll open: within @joc/protocol's MAX_ANSWER_WAIT_MS. */
export const ANSWER_POLL_MS = 8000;

/** The tool whose permission request is a question put to the person. */
export const ASK_TOOL = 'AskUserQuestion';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const str = (value: unknown) => (typeof value === 'string' ? value : undefined);

const cut = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** First non-empty line, whitespace collapsed, cut to `max`. */
function firstLine(text: string | undefined, max: number): string | undefined {
  const line = text
    ?.split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .find(Boolean);
  return line ? cut(line, max) : undefined;
}

/** What a tool call touches, one line: a command, a path (relative to `cwd`), a URL. */
export function callSummary(tool: string, input: unknown, cwd = ''): string {
  const args = record(input);
  if (tool === 'Bash') return firstLine(str(args.command), 500) ?? '';
  const path = str(args.file_path) ?? str(args.notebook_path);
  if (path) {
    const root = cwd.replace(/\/+$/, '');
    return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  }
  const other = str(args.pattern) ?? str(args.url) ?? str(args.query) ?? str(args.prompt);
  return firstLine(other, 500) ?? '';
}

function questionsOf(input: unknown): WaitingQuestion[] {
  const list = record(input).questions;
  if (!Array.isArray(list)) return [];
  return list.slice(0, 4).flatMap((q): WaitingQuestion[] => {
    const question = str(record(q).question)?.trim();
    if (!question) return [];
    const header = str(record(q).header);
    const options = (Array.isArray(record(q).options) ? (record(q).options as unknown[]) : [])
      .slice(0, 10)
      .flatMap((o) => {
        const label = str(record(o).label)?.trim();
        const description = str(record(o).description);
        if (!label) return [];
        return [
          {
            label: cut(label, 200),
            ...(description ? { description: cut(description, 500) } : {}),
          },
        ];
      });
    return [
      {
        question: cut(question, 2000),
        ...(header ? { header: cut(header, 100) } : {}),
        options,
        multiSelect: record(q).multiSelect === true,
      },
    ];
  });
}

/**
 * What a permission request waits on, for JOC. Undefined when it can't be put there (a question
 * with nothing in it): Claude Code's own prompt is then the only way to answer.
 */
export function waitingFor(
  id: string,
  tool: string,
  input: unknown,
  cwd?: string,
): Waiting | undefined {
  if (tool === ASK_TOOL) {
    const questions = questionsOf(input);
    return questions.length ? { kind: 'question', id, questions } : undefined;
  }
  const description = str(record(input).description);
  return {
    kind: 'permission',
    id,
    tool: cut(tool, 200),
    summary: callSummary(tool, input, cwd),
    ...(description ? { description: cut(description, 500) } : {}),
  };
}

/** A PermissionRequest hook's answer: allow this one call, or deny it. */
export type Decision =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string };

/**
 * The decision a JOC answer becomes, or undefined when it doesn't answer this wait. An allow is
 * for this call only: it carries the call's own input (with a question's answers filled in) and
 * never a permission rule. Claude Code needs the input for an allow to take.
 */
export function decisionFor(
  waiting: Waiting,
  answer: Answer,
  input: unknown,
): Decision | undefined {
  if (waiting.kind === 'permission') {
    if (answer.kind !== 'permission') return undefined;
    return answer.allow
      ? { behavior: 'allow', updatedInput: { ...record(input) } }
      : { behavior: 'deny', message: 'Denied from JOC.' };
  }
  if (answer.kind !== 'question') return undefined;
  const asked = waiting.questions.map((q) => q.question);
  if (!asked.every((q) => typeof answer.answers[q] === 'string')) return undefined;
  const answers = Object.fromEntries(asked.map((q) => [q, answer.answers[q]]));
  return { behavior: 'allow', updatedInput: { ...record(input), answers } };
}

/** The answer in a claim's reply (`ClaimedAnswer`), or undefined for none or a bad one. */
export function answerOf(body: unknown): Answer | undefined {
  const answer = record(record(body).answer);
  if (answer.kind === 'permission' && typeof answer.allow === 'boolean') {
    return { kind: 'permission', allow: answer.allow };
  }
  if (answer.kind !== 'question') return undefined;
  const entries = Object.entries(record(answer.answers)).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim() !== '',
  );
  return entries.length ? { kind: 'question', answers: Object.fromEntries(entries) } : undefined;
}

/** A key for a tool call's input, the same however its keys are ordered. */
export function inputKey(tool: string, input: unknown): string {
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sorted);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((k) => [k, sorted((value as Record<string, unknown>)[k])]),
      );
    }
    return value;
  };
  return `${tool}\n${JSON.stringify(sorted(input) ?? null)}`;
}

/** A fresh wait id. */
export function newWaitingId(): string {
  const bytes = new Uint8Array(12);
  const crypto = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => void } }).crypto;
  if (crypto?.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return `w-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

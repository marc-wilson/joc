import {
  type Answer,
  type AnsweredBy,
  AnswerRefused,
  type Session,
  type Waiting,
} from '@joc/protocol';
import { useSyncExternalStore } from 'react';

// Answering what a session waits on, from the needs rows, the toasts and the session's own view.
// The plugin races the terminal: whichever answers first wins. This page remembers what it sent
// for each wait, so every place that shows the wait says the same thing about it. UI-free.

/** What this page did about a wait. */
export type Sent =
  | { state: 'sending' }
  /** The server took it; the plugin hands it to Claude Code. */
  | { state: 'sent' }
  /** The wait was over by the time it arrived. */
  | { state: 'refused'; by?: AnsweredBy }
  | { state: 'failed' };

let sent = new Map<string, Sent>();
const listeners = new Set<() => void>();

function set(waitingId: string, value: Sent) {
  sent = new Map(sent).set(waitingId, value);
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** What this page sent for each wait, by wait id; changes as answers go out. */
export function useSent(): Map<string, Sent> {
  return useSyncExternalStore(subscribe, () => sent);
}

/** Sends an answer once per wait; a second press while one is out does nothing. */
export async function sendAnswer(
  sessionId: string,
  waitingId: string,
  answer: Answer,
  /** apiFetch, passed in so this module stays free of the browser. */
  post: (path: string, init: RequestInit) => Promise<Response>,
): Promise<Sent> {
  const before = sent.get(waitingId);
  if (before && before.state !== 'failed') return before;
  set(waitingId, { state: 'sending' });
  let outcome: Sent;
  try {
    const res = await post(`/api/sessions/${encodeURIComponent(sessionId)}/answers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ waitingId, answer }),
    });
    if (res.ok) outcome = { state: 'sent' };
    else if (res.status === 409) {
      const refused = AnswerRefused.safeParse(await res.json().catch(() => null));
      outcome = { state: 'refused', by: refused.success ? refused.data.answeredBy : undefined };
    } else outcome = { state: 'failed' };
  } catch {
    outcome = { state: 'failed' };
  }
  set(waitingId, outcome);
  return outcome;
}

/** Who answered the wait, as far as anyone here knows. */
export function answeredBy(
  waitingId: string,
  session: Pick<Session, 'answered'>,
  mine?: Sent,
): AnsweredBy | undefined {
  if (session.answered?.id === waitingId) return session.answered.by;
  return mine?.state === 'refused' ? mine.by : undefined;
}

/**
 * The one line about a wait's answer, in place of its answers; undefined while it waits on you
 * and nothing was sent.
 */
export function answerStatus(
  waitingId: string,
  session: Pick<Session, 'answered'>,
  mine?: Sent,
): string | undefined {
  const by = answeredBy(waitingId, session, mine);
  if (by === 'claude-code') return 'Answered in Claude Code';
  if (by === 'joc') return 'Answered from JOC';
  switch (mine?.state) {
    case 'sending':
    case 'sent':
      return 'Sending…';
    case 'refused':
      return 'Already answered';
    case 'failed':
      return 'Couldn’t send it. Answer in Claude Code.';
    default:
      return undefined;
  }
}

/** The wait a session has now, while it needs you. */
export const waitingOf = (session: Session | undefined): Waiting | undefined =>
  session?.state === 'needs' ? session.waiting : undefined;

/** A question a needs row can answer in one press: one question, one choice, with options. */
export function quickQuestion(waiting: Waiting | undefined) {
  if (waiting?.kind !== 'question' || waiting.questions.length !== 1) return undefined;
  const [only] = waiting.questions;
  return only && !only.multiSelect && only.options.length ? only : undefined;
}

/** The answer to a question by its text. */
export const questionAnswer = (answers: Record<string, string>): Answer => ({
  kind: 'question',
  answers,
});

/** "Allow once" or "Deny": never a rule for later calls. */
export const permissionAnswer = (allow: boolean): Answer => ({ kind: 'permission', allow });

/**
 * The waits this page answered that Claude Code was answered first for: each worth saying, once,
 * that the answer from JOC was dropped.
 */
export function droppedAnswers(
  sessions: Pick<Session, 'id' | 'title' | 'answered'>[],
  mine: Map<string, Sent>,
): { waitingId: string; sessionId?: string; title?: string }[] {
  return [...mine].flatMap(([waitingId, s]) => {
    if (s.state !== 'sent' && s.state !== 'refused') return [];
    const session = sessions.find((x) => x.answered?.id === waitingId);
    const by = session?.answered?.by ?? (s.state === 'refused' ? s.by : undefined);
    return by === 'claude-code'
      ? [{ waitingId, sessionId: session?.id, title: session?.title }]
      : [];
  });
}

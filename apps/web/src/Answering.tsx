import type { Answer, Session, Waiting } from '@joc/protocol';
import { Code, NeedsAnswers, QuestionCard } from '@joc/ui';
import { useEffect, useRef, useState } from 'react';
import {
  answerStatus,
  permissionAnswer,
  questionAnswer,
  quickQuestion,
  sendAnswer,
  useSent,
  waitingOf,
} from './answers.ts';
import { apiFetch } from './auth.ts';
import type { Note } from './notes.ts';

// Answering a waiting session from JOC: a needs row's or toast's answers, and the session view's
// cards. Claude Code asks in the terminal at the same time; the first answer wins.

/** Where "Other…" goes: the session, at its question card. */
export const ANSWER_HASH = '#answer';

/** A value such as a domain or a path reads better in mono. */
const looksLikeValue = (label: string) => !/\s/.test(label) && /[./:@]/.test(label);

/** A needs row's or toast's answers: options, Other…, or Allow once and Deny. */
export function NoteAnswers({ note, sessions }: { note: Note; sessions: Session[] }) {
  const mine = useSent();
  const session = sessions.find((s) => s.id === note.sessionId);
  const waiting = waitingOf(session);
  if (!session || !waiting) {
    // A plugin from before 0.9.0 takes no answers.
    return <span className="jn-answers__note">Answer it in Claude Code</span>;
  }
  const status = answerStatus(waiting.id, session, mine.get(waiting.id));
  if (status) return <NeedsAnswers status={status} />;
  const send = (answer: Answer) => void sendAnswer(session.id, waiting.id, answer, apiFetch);
  if (waiting.kind === 'permission') {
    return (
      <NeedsAnswers
        onAllow={() => send(permissionAnswer(true))}
        onDeny={() => send(permissionAnswer(false))}
      />
    );
  }
  const open = () => location.assign(`${note.href}${ANSWER_HASH}`);
  const quick = quickQuestion(waiting);
  if (!quick) return <NeedsAnswers onOther={open} otherLabel="Answer…" />;
  return (
    <NeedsAnswers
      options={quick.options.map((o) => ({ label: o.label, mono: looksLikeValue(o.label) }))}
      onPick={(i) => {
        const label = quick.options[i]?.label;
        if (label) send(questionAnswer({ [quick.question]: label }));
      }}
      onOther={open}
    />
  );
}

interface Shown {
  waiting: Waiting;
  /** How many conversation items there were when the wait ended. */
  endedAt?: number;
}

/**
 * The session view's answer cards, under the conversation while the session waits on you. Once
 * answered, a card says who answered and stays until the conversation moves on below it.
 */
export function WaitingCards({ session, items }: { session: Session; items: number }) {
  const mine = useSent();
  const now = waitingOf(session);
  const [shown, setShown] = useState<Shown>();
  const [picked, setPicked] = useState<Record<string, string>>({});
  const root = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: follows the wait's id and the count
  useEffect(() => {
    if (now && now.id !== shown?.waiting.id) {
      setShown({ waiting: now });
      setPicked({});
    } else if (!now && shown && shown.endedAt === undefined) {
      setShown({ ...shown, endedAt: items });
    }
  }, [now?.id, items]);

  // From a needs row's "Other…": to the card, with its words ready to type.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the card first shows
  useEffect(() => {
    if (!shown || location.hash !== ANSWER_HASH) return;
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    root.current?.scrollIntoView({ block: 'nearest' });
    const field =
      root.current?.querySelector<HTMLInputElement>('.joc-q__other') ??
      root.current?.querySelector<HTMLInputElement>('input');
    field?.focus();
  }, [shown?.waiting.id]);

  if (!shown) return null;
  const { waiting, endedAt } = shown;
  const status = answerStatus(waiting.id, session, mine.get(waiting.id));
  // Over: shown until the conversation moves on, and only if someone answered it.
  if (endedAt !== undefined && (items > endedAt || !status)) return null;
  const over = endedAt !== undefined || !!status;
  const send = (answer: Answer) => void sendAnswer(session.id, waiting.id, answer, apiFetch);

  if (waiting.kind === 'permission') {
    const command = waiting.tool === 'Bash';
    return (
      <div ref={root} className="joc-fade-in">
        <QuestionCard
          header={command ? 'Claude wants to run a command' : `Claude wants to use ${waiting.tool}`}
          question={<Code>{waiting.summary || waiting.tool}</Code>}
          label={waiting.description ?? waiting.summary}
          options={[
            { label: 'Allow once', description: 'This call only. No rule is added.' },
            { label: 'Deny' },
          ]}
          other={false}
          answered={over}
          status={status}
          onAnswer={(label) => send(permissionAnswer(label === 'Allow once'))}
        />
      </div>
    );
  }

  const questions = waiting.questions;
  return (
    <div ref={root} className="joc-stack joc-fade-in">
      {questions.map((q, i) => {
        const last = i === questions.length - 1;
        return (
          <QuestionCard
            key={q.question}
            header={q.header}
            question={q.question}
            options={q.options}
            multi={q.multiSelect}
            answered={over || picked[q.question] !== undefined}
            status={last ? status : undefined}
            sendLabel={last || questions.length === 1 ? 'Send answer' : 'Next'}
            onAnswer={(text) => {
              const next = { ...picked, [q.question]: text };
              setPicked(next);
              if (questions.every((x) => next[x.question] !== undefined)) {
                send(questionAnswer(next));
              }
            }}
          />
        );
      })}
    </div>
  );
}

import type { Session } from '@joc/protocol';
import {
  Code,
  Composer,
  EmptyState,
  Message,
  NavBar,
  NewSessionButton,
  QuestionCard,
  RepoGroupHeader,
  SessionHeader,
  SessionRow,
  SlashPill,
  TextInput,
  Thread,
} from '@joc/ui';
import { Fragment, useState } from 'react';
import { conversations, sessions, type Turn } from './fixtures.ts';
import { age } from './time.ts';

// Repos in first-seen order, so groups never reorder as sessions update.
function groupByRepo(list: Session[]): [string, Session[]][] {
  const groups = new Map<string, Session[]>();
  for (const s of list) groups.set(s.repo, [...(groups.get(s.repo) ?? []), s]);
  return [...groups];
}

function TurnView({ turn }: { turn: Turn }) {
  switch (turn.kind) {
    case 'user':
      return (
        <Message from="user" time={turn.time}>
          {turn.command ? <SlashPill command={turn.command} /> : null} {turn.text}
        </Message>
      );
    case 'claude':
      return (
        <Message from="claude" time={turn.time}>
          <div className="joc-md">
            {turn.paragraphs.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </div>
        </Message>
      );
    case 'tool':
      return (
        <Message
          from="tool"
          name={turn.name}
          target={turn.target}
          meta={turn.meta}
          status={turn.status}
        >
          {turn.output ? <Code>{turn.output}</Code> : null}
        </Message>
      );
    case 'question':
      return <QuestionCard question={turn.question} options={turn.options} />;
  }
}

export default function App() {
  const [selectedId, setSelectedId] = useState(sessions[0]?.id);
  const selected = sessions.find((s) => s.id === selectedId);
  const needs = sessions.filter((s) => s.state === 'needs').length;
  const turns = (selected && conversations[selected.id]) ?? [];

  return (
    <div className="joc-app app">
      <NavBar
        items={[
          { id: 'sessions', label: 'Sessions', needs },
          { id: 'github', label: 'GitHub' },
          { id: 'history', label: 'History' },
        ]}
        value="sessions"
        machine="dev-mbp"
        user="Sam Lee"
      />
      <div className="joc-app__body">
        <aside className="joc-app__side">
          <div className="app-side__filter">
            <TextInput placeholder="Filter sessions" kbd="/" />
          </div>
          <div className="app-side__list" role="listbox" aria-label="Sessions">
            {groupByRepo(sessions).map(([repo, list]) => (
              <Fragment key={repo}>
                <RepoGroupHeader
                  repo={repo}
                  count={list.length}
                  needs={list.filter((s) => s.state === 'needs').length}
                />
                {list.map((s) => (
                  <SessionRow
                    key={s.id}
                    state={s.state}
                    title={s.title}
                    branch={s.branch}
                    contextLeft={s.contextLeft}
                    activity={s.activity}
                    time={age(s.updatedAt)}
                    selected={s.id === selectedId}
                    onSelect={() => setSelectedId(s.id)}
                  />
                ))}
                <NewSessionButton repo={repo} />
              </Fragment>
            ))}
          </div>
        </aside>
        <main className="joc-app__main">
          {selected ? (
            <>
              <SessionHeader
                title={selected.title}
                state={selected.state}
                repo={selected.repo}
                branch={selected.branch}
                machine={selected.machine}
                model={selected.model}
                contextLeft={selected.contextLeft}
                tabs={[
                  { id: 'conversation', label: 'Conversation' },
                  { id: 'background', label: 'Background' },
                  { id: 'changes', label: 'Changes' },
                ]}
                tab="conversation"
              />
              <div className="app-main__scroll">
                {turns.length ? (
                  <Thread>
                    {turns.map((t, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: turns are append-only, so position is stable
                      <TurnView key={i} turn={t} />
                    ))}
                  </Thread>
                ) : (
                  <EmptyState
                    title="No messages yet"
                    body="This session's conversation will show here."
                  />
                )}
              </div>
              <div className="app-main__dock">
                <Thread>
                  <Composer working={selected.state === 'working'} />
                </Thread>
              </div>
            </>
          ) : (
            <EmptyState
              title="No live sessions"
              body="Start Claude Code with the JOC plugin to see it here."
            />
          )}
        </main>
      </div>
    </div>
  );
}

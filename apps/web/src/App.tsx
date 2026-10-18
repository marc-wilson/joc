import type { Session } from '@joc/protocol';
import {
  Composer,
  EmptyState,
  NavBar,
  NewSessionButton,
  RepoGroupHeader,
  SessionHeader,
  SessionRow,
  TextInput,
} from '@joc/ui';
import { Fragment, useState } from 'react';
import { Conversation } from './Conversation.tsx';
import { useConversation, useNow, useSessions } from './hooks.ts';
import { age } from './time.ts';

// Repos in first-seen order, so groups never reorder as sessions update.
function groupByRepo(list: Session[]): [string, Session[]][] {
  const groups = new Map<string, Session[]>();
  for (const s of list) groups.set(s.repo, [...(groups.get(s.repo) ?? []), s]);
  return [...groups];
}

const UNTITLED = 'New session';

export default function App() {
  const { sessions, connected } = useSessions();
  const now = useNow();
  const [selectedId, setSelectedId] = useState<string>();
  const selected = sessions.find((s) => s.id === selectedId) ?? sessions[0];
  const needs = sessions.filter((s) => s.state === 'needs').length;
  const items = useConversation(selected?.id);

  return (
    <div className="joc-app app">
      <NavBar
        items={[
          { id: 'sessions', label: 'Sessions', needs },
          { id: 'github', label: 'GitHub' },
          { id: 'history', label: 'History' },
        ]}
        value="sessions"
        machine={connected ? 'Connected' : 'Reconnecting'}
        machineOffline={!connected}
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
                    title={s.title ?? UNTITLED}
                    branch={s.branch}
                    contextLeft={s.contextLeft}
                    activity={s.activity}
                    time={age(s.updatedAt, now)}
                    selected={s.id === selected?.id}
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
                title={selected.title ?? UNTITLED}
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
              <Conversation key={selected.id} items={items} state={selected.state} />
              <div className="app-main__dock">
                <Composer disabled hint="Sending prompts from JOC isn't built yet" />
              </div>
            </>
          ) : (
            <EmptyState
              title="No live sessions"
              body="Install the JOC plugin in Claude Code, then start a session."
              command="/plugin marketplace add marc-wilson/joc"
            />
          )}
        </main>
      </div>
    </div>
  );
}

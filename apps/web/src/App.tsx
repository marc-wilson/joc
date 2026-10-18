import type { Session } from '@joc/protocol';
import {
  Composer,
  EmptyState,
  NavBar,
  NewSessionButton,
  RepoGroupHeader,
  SessionHeader,
  SessionRail,
  SessionRow,
  TextInput,
} from '@joc/ui';
import { Fragment, useState } from 'react';
import { ChangesView } from './Changes.tsx';
import { Conversation, type PendingPrompt } from './Conversation.tsx';
import { useChanges, useConversation, useNow, useSessions } from './hooks.ts';
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
  const changes = useChanges(selected?.id);
  const [tab, setTab] = useState('conversation');
  // The Changes tab needs the width, so the session list folds into a rail of state dots.
  const [listOpen, setListOpen] = useState(false);
  const railed = tab === 'changes' && !listOpen;
  const [pending, setPending] = useState<PendingPrompt[]>([]);
  // A sent prompt shows until the session's own transcript has it.
  const waiting = pending.filter(
    (p) =>
      p.sessionId === selected?.id &&
      !items.some((i) => i.kind === 'user' && i.text.trim() === p.text),
  );

  async function send(sessionId: string, text: string) {
    const prompt: PendingPrompt = { id: crypto.randomUUID(), sessionId, text };
    setPending((list) => [...list, prompt]);
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/prompts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    }).catch(() => undefined);
    if (!res?.ok) {
      setPending((list) => list.map((p) => (p.id === prompt.id ? { ...p, failed: true } : p)));
    }
  }

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
        {railed ? (
          <aside className="joc-app__side is-rail">
            <SessionRail
              groups={groupByRepo(sessions).map(([repo, list]) => ({
                repo,
                sessions: list.map((s) => ({
                  id: s.id,
                  state: s.state,
                  title: s.title ?? UNTITLED,
                  selected: s.id === selected?.id,
                })),
              }))}
              onExpand={() => setListOpen(true)}
              onSelect={(s) => setSelectedId(s.id)}
            />
          </aside>
        ) : (
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
        )}
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
                  { id: 'background', label: 'Background', disabled: true },
                  {
                    id: 'changes',
                    label: 'Changes',
                    count: changes.status === 'ready' ? changes.files.length : undefined,
                  },
                ]}
                tab={tab}
                onTabChange={(id) => {
                  setTab(id);
                  setListOpen(false);
                }}
              />
              {tab === 'changes' ? (
                <ChangesView
                  key={selected.id}
                  sessionId={selected.id}
                  changes={changes}
                  onSend={(text) => {
                    void send(selected.id, text);
                    setTab('conversation');
                  }}
                />
              ) : (
                <>
                  <Conversation
                    key={selected.id}
                    items={items}
                    pending={waiting}
                    state={selected.state}
                  />
                  <div className="app-main__dock">
                    {selected.state === 'offline' ? (
                      <Composer disabled hint="This session is offline" />
                    ) : (
                      <Composer
                        key={selected.id}
                        working={selected.state === 'working'}
                        onSubmit={(text) => void send(selected.id, text)}
                      />
                    )}
                  </div>
                </>
              )}
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

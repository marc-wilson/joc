import {
  IMAGE_TYPES,
  ImageRef,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  type Session,
} from '@joc/protocol';
import {
  Button,
  Composer,
  EmptyState,
  NewSessionButton,
  RepoGroupHeader,
  SessionHeader,
  SessionRail,
  SessionRow,
  TextInput,
} from '@joc/ui';
import { Fragment, useState } from 'react';
import { apiFetch } from './auth.ts';
import { BackgroundView } from './Background.tsx';
import { backgroundTasks } from './background.ts';
import { ChangesView } from './Changes.tsx';
import { Conversation } from './Conversation.tsx';
import { useChanges, useConversation, useNow, useSessions } from './hooks.ts';
import { Nav } from './Nav.tsx';
import { delivered, type PendingPrompt } from './pending.ts';
import { plain } from './plain.ts';
import { toggled, usePref } from './prefs.ts';
import { age } from './time.ts';

// Repos in first-seen order, so groups never reorder as sessions update.
function groupByRepo(list: Session[]): [string, Session[]][] {
  const groups = new Map<string, Session[]>();
  for (const s of list) groups.set(s.repo, [...(groups.get(s.repo) ?? []), s]);
  return [...groups];
}

const UNTITLED = 'New session';

const IMAGE_LIMITS = { types: IMAGE_TYPES, maxBytes: MAX_IMAGE_BYTES, max: MAX_IMAGES_PER_MESSAGE };

/** Uploads a pasted image; its stored ref, or undefined when the server didn't take it. */
async function uploadImage(file: File): Promise<ImageRef | undefined> {
  const res = await apiFetch('/api/images', {
    method: 'POST',
    headers: { 'content-type': file.type },
    body: file,
  });
  if (!res.ok) return undefined;
  const parsed = ImageRef.safeParse(await res.json());
  return parsed.success ? parsed.data : undefined;
}

export default function App() {
  const { sessions, connected } = useSessions();
  const now = useNow();
  // A link like /?session=<id> (from a PR on the GitHub page) opens that session.
  const [selectedId, setSelectedId] = useState(
    () => new URLSearchParams(location.search).get('session') ?? undefined,
  );
  const selected = sessions.find((s) => s.id === selectedId) ?? sessions[0];
  const needs = sessions.filter((s) => s.state === 'needs').length;
  const items = useConversation(selected?.id);
  const changes = useChanges(selected?.id);
  const tasks = selected ? backgroundTasks(items, selected.state) : [];
  const running = tasks.filter((t) => t.status === 'running').length;
  const [tab, setTab] = useState('conversation');
  // The Changes tab needs the width, so the session list folds into a rail of state dots.
  const [listOpen, setListOpen] = useState(false);
  // You can also fold it on any tab; that choice is remembered in this browser.
  const [listFolded, setListFolded] = usePref('joc:list-folded', false);
  const railed = listFolded || (tab === 'changes' && !listOpen);
  // Session list groups you folded, remembered in this browser.
  const [folded, setFolded] = usePref<string[]>('joc:folded-groups', []);
  const [pending, setPending] = useState<PendingPrompt[]>([]);
  // A sent prompt shows until the session's own transcript has it.
  const waiting = pending.filter((p) => p.sessionId === selected?.id && !delivered(items, p));

  async function send(sessionId: string, text: string, files: File[] = []) {
    const prompt: PendingPrompt = { id: crypto.randomUUID(), sessionId, text, images: [] };
    const update = (change: Partial<PendingPrompt>) =>
      setPending((list) => list.map((p) => (p.id === prompt.id ? { ...p, ...change } : p)));
    setPending((list) => [...list, prompt]);
    try {
      // The images first: the prompt refers to them by the ids the server gives them.
      const images = await Promise.all(files.map(uploadImage));
      const uploaded = images.filter((i) => i !== undefined);
      update({ images: uploaded });
      if (uploaded.length < files.length) return update({ failed: true });
      const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/prompts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, images: uploaded.map((i) => i.id) }),
      });
      if (!res.ok) update({ failed: true });
    } catch {
      // The server is unreachable: the prompt shows as not sent.
      update({ failed: true });
    }
  }

  return (
    <div className="joc-app app">
      <Nav page="sessions" needs={needs} connected={connected} />
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
              onExpand={() => {
                setListFolded(false);
                setListOpen(true);
              }}
              onSelect={(s) => setSelectedId(s.id)}
            />
          </aside>
        ) : (
          <aside className="joc-app__side">
            <div className="app-side__filter">
              <TextInput placeholder="Filter sessions" kbd="/" />
              <Button
                variant="ghost"
                size="sm"
                icon="chevronLeft"
                aria-label="Collapse session list"
                title="Collapse session list"
                onClick={() => setListFolded(true)}
              />
            </div>
            <div className="app-side__list" role="listbox" aria-label="Sessions">
              {groupByRepo(sessions).map(([repo, list]) => (
                <Fragment key={repo}>
                  <RepoGroupHeader
                    repo={repo}
                    count={list.length}
                    needs={list.filter((s) => s.state === 'needs').length}
                    collapsed={folded.includes(`repo:${repo}`)}
                    onToggle={() =>
                      setFolded(toggled(folded, `repo:${repo}`, !folded.includes(`repo:${repo}`)))
                    }
                  />
                  {folded.includes(`repo:${repo}`) ? null : (
                    <>
                      {list.map((s) => (
                        <SessionRow
                          key={s.id}
                          state={s.state}
                          title={s.title ?? UNTITLED}
                          branch={s.branch}
                          contextLeft={s.contextLeft}
                          activity={s.activity && plain(s.activity)}
                          time={age(s.updatedAt, now)}
                          selected={s.id === selected?.id}
                          onSelect={() => setSelectedId(s.id)}
                        />
                      ))}
                      <NewSessionButton repo={repo} />
                    </>
                  )}
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
                  {
                    id: 'background',
                    label: 'Background',
                    count: running || undefined,
                    state: running ? 'background' : undefined,
                  },
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
              {tab === 'background' ? (
                <BackgroundView key={selected.id} tasks={tasks} />
              ) : tab === 'changes' ? (
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
                    sessionId={selected.id}
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
                        imageLimits={IMAGE_LIMITS}
                        onSubmit={(text, images) => void send(selected.id, text, images)}
                      />
                    )}
                  </div>
                </>
              )}
            </>
          ) : (
            <EmptyState
              title="No live sessions"
              body="Install the JOC plugin in Claude Code, link this machine with /joc-login, then start a session."
              command="/plugin marketplace add marc-wilson/joc"
            />
          )}
        </main>
      </div>
    </div>
  );
}

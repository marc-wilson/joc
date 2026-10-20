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
  SessionListFooter,
  SessionListNote,
  SessionRail,
  SessionRow,
  TextInput,
  TextLink,
} from '@joc/ui';
import { Fragment, useEffect, useState } from 'react';
import { apiFetch } from './auth.ts';
import { BackgroundView } from './Background.tsx';
import { backgroundTasks, runningCount, runningLine } from './background.ts';
import { ChangesView } from './Changes.tsx';
import { Conversation } from './Conversation.tsx';
import {
  useAlerts,
  useChanges,
  useConversation,
  useHistory,
  useNow,
  useReadWhileViewing,
  useSessionSettings,
  useSessions,
} from './hooks.ts';
import { Nav } from './Nav.tsx';
import { NewSessionDialog } from './NewSession.tsx';
import { delivered, type PendingPrompt } from './pending.ts';
import { plain } from './plain.ts';
import { updatePrefs, usePrefs } from './prefs.ts';
import { isQuiet, keepNote, matchesFilter } from './session-list.ts';
import { groupSessions, PINNED_GROUP } from './sessions.ts';
import { age } from './time.ts';
import { toggled } from './toggled.ts';

const UNTITLED = 'New session';

const FILTER_ID = 'session-filter';

/** The row's activity line: what Claude is doing, or, once it stopped reporting, what it last did. */
function activityOf(s: Session, now: number): string | undefined {
  // Work running on in the background is counted from Claude Code's list, as the tab counts it.
  const activity =
    s.state === 'background' && s.background?.tasks.length
      ? runningLine(s.background.tasks.length)
      : s.activity && plain(s.activity);
  if (!isQuiet(s, now)) return activity;
  const silent = `No word from ${s.machine ?? 'its machine'}`;
  return activity ? `${silent} · last: ${activity}` : silent;
}

/** "Quiet 6m" for a session whose machine stopped reporting, in place of its time. */
const quietOf = (s: Session, now: number) =>
  isQuiet(s, now) ? `Quiet ${age(s.updatedAt, now)}` : undefined;

/** `/` jumps to the session filter, unless the person is already typing somewhere. */
function useFilterShortcut() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const at = e.target;
      if (at instanceof HTMLElement && (at.isContentEditable || at.closest('input, textarea'))) {
        return;
      }
      e.preventDefault();
      document.getElementById(FILTER_ID)?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}

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
  const [filter, setFilter] = useState('');
  const filtering = filter.trim() !== '';
  useFilterShortcut();
  // Sessions no longer on the live list, read once the filter has text to match them against.
  const history = useHistory(filtering);
  const older = filtering
    ? (history ?? []).filter(
        (h) => matchesFilter(h, filter) && !sessions.some((s) => s.id === h.id),
      )
    : [];
  // An older session opened from the filter, kept selected after the filter clears.
  const [opened, setOpened] = useState<Session>();
  const shown = sessions.filter((s) => matchesFilter(s, filter));
  const selected =
    sessions.find((s) => s.id === selectedId) ??
    (opened?.id === selectedId ? opened : undefined) ??
    sessions[0];
  const keep = useSessionSettings();
  // The repo a new session is being started on.
  const [newIn, setNewIn] = useState<string>();
  useReadWhileViewing(useAlerts(), selected?.id);
  const items = useConversation(selected?.id);
  const changes = useChanges(selected?.id);
  const tasks = selected ? backgroundTasks(items, selected.state, selected.background) : [];
  const running = runningCount(tasks);
  const [tab, setTab] = useState('conversation');
  // The Changes tab needs the width, so the session list folds into a rail of state dots.
  const [listOpen, setListOpen] = useState(false);
  // You can also fold it on any tab; that choice, the groups you folded and the sessions you
  // pinned to the top (in the order you pinned them) are remembered.
  const { listFolded, foldedGroups: folded, pinned } = usePrefs();
  const railed = listFolded || (tab === 'changes' && !listOpen);
  const groups = groupSessions(shown, pinned);
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
      <Nav page="sessions" connected={connected} viewing={selected?.id} />
      <div className="joc-app__body">
        {railed ? (
          <aside className="joc-app__side is-rail">
            <SessionRail
              groups={groups.map((g) => ({
                repo: g.label,
                pinned: g.id === PINNED_GROUP,
                sessions: g.sessions.map((s) => ({
                  id: s.id,
                  state: s.state,
                  title: s.title ?? UNTITLED,
                  quiet: quietOf(s, now),
                  selected: s.id === selected?.id,
                })),
              }))}
              onExpand={() => {
                updatePrefs({ listFolded: false });
                setListOpen(true);
              }}
              onSelect={(s) => setSelectedId(s.id)}
            />
          </aside>
        ) : (
          <aside className="joc-app__side">
            <div className="app-side__filter">
              <TextInput
                id={FILTER_ID}
                placeholder="Filter sessions"
                kbd="/"
                value={filter}
                onChange={setFilter}
              />
              <Button
                variant="ghost"
                size="sm"
                icon="chevronLeft"
                aria-label="Collapse session list"
                title="Collapse session list"
                onClick={() => updatePrefs({ listFolded: true })}
              />
            </div>
            <div className="app-side__list" role="listbox" aria-label="Sessions">
              {groups.map((g) => (
                <Fragment key={g.id}>
                  <RepoGroupHeader
                    repo={g.label}
                    count={g.sessions.length}
                    needs={g.sessions.filter((s) => s.state === 'needs').length}
                    pinned={g.id === PINNED_GROUP}
                    collapsed={folded.includes(g.id)}
                    onToggle={() =>
                      updatePrefs({ foldedGroups: toggled(folded, g.id, !folded.includes(g.id)) })
                    }
                  />
                  {/* Pinned never folds: its header isn't a toggle. */}
                  {g.id !== PINNED_GROUP && folded.includes(g.id) ? null : (
                    <>
                      {g.sessions.map((s) => (
                        <SessionRow
                          key={s.id}
                          state={s.state}
                          title={s.title ?? UNTITLED}
                          branch={s.branch}
                          contextLeft={s.contextLeft}
                          activity={activityOf(s, now)}
                          time={age(s.updatedAt, now)}
                          quiet={quietOf(s, now)}
                          selected={s.id === selected?.id}
                          pinned={g.id === PINNED_GROUP}
                          onSelect={() => setSelectedId(s.id)}
                          onPinChange={(on) => updatePrefs({ pinned: toggled(pinned, s.id, on) })}
                        />
                      ))}
                      {filtering || g.id === PINNED_GROUP ? null : (
                        <NewSessionButton repo={g.label} onClick={() => setNewIn(g.label)} />
                      )}
                    </>
                  )}
                </Fragment>
              ))}
              {filtering && !shown.length && history && !older.length ? (
                <SessionListNote>No sessions match.</SessionListNote>
              ) : null}
              {older.length ? (
                <>
                  <SessionListNote>Older sessions, no longer on this list</SessionListNote>
                  {groupSessions(older, []).map((g) => (
                    <Fragment key={g.id}>
                      <RepoGroupHeader repo={g.label} count={g.sessions.length} />
                      {g.sessions.map((s) => (
                        <SessionRow
                          key={s.id}
                          state={s.state}
                          title={s.title ?? UNTITLED}
                          branch={s.branch}
                          contextLeft={s.contextLeft}
                          activity={activityOf(s, now)}
                          time={age(s.updatedAt, now)}
                          selected={s.id === selected?.id}
                          onSelect={() => {
                            setOpened(s);
                            setSelectedId(s.id);
                          }}
                        />
                      ))}
                    </Fragment>
                  ))}
                </>
              ) : null}
            </div>
            {keep.settings ? (
              <SessionListFooter
                links={
                  <>
                    <TextLink href="/history">History</TextLink>
                    <TextLink href="/settings#sessions">Change</TextLink>
                  </>
                }
              >
                {keepNote(keep.settings)} Filter to find older ones.
              </SessionListFooter>
            ) : null}
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
                    countLabel: running ? `${running} running` : undefined,
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
                <BackgroundView key={selected.id} sessionId={selected.id} tasks={tasks} />
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
                    session={selected}
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
      {newIn ? (
        <NewSessionDialog
          repo={newIn}
          candidates={sessions.filter((s) => s.repo === newIn)}
          sessions={sessions}
          onOpen={(id) => {
            setNewIn(undefined);
            setSelectedId(id);
          }}
          onClose={() => setNewIn(undefined)}
        />
      ) : null}
    </div>
  );
}

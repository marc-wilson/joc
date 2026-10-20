import {
  IMAGE_TYPES,
  ImageRef,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  MAX_PREF_ITEMS,
  type Session,
} from '@joc/protocol';
import {
  Button,
  CIMark,
  Composer,
  EmptyState,
  NewSessionButton,
  OverflowMenu,
  RepoGroupHeader,
  ReviewSessionRow,
  SessionHeader,
  SessionListFooter,
  SessionListNote,
  SessionRail,
  SessionRow,
  SortBar,
  TextInput,
  TextLink,
} from '@joc/ui';
import { Fragment, type ReactNode, useEffect, useState } from 'react';
import { apiFetch } from './auth.ts';
import { BackgroundView } from './Background.tsx';
import { backgroundTasks, runningCount, runningLine } from './background.ts';
import { ChangesView } from './Changes.tsx';
import { Conversation } from './Conversation.tsx';
import { DeleteDialog } from './DeleteSessions.tsx';
import { cantDelete, deletionLine, deletionOf, machineLive, removedLine } from './deletes.ts';
import { useHeldOrder } from './held-order.ts';
import {
  useChanges,
  useCmdlistMax,
  useCommands,
  useConversation,
  useDeletes,
  useGitHub,
  useHistory,
  useNow,
  useReadWhileViewing,
  useSessionSettings,
  useSessions,
} from './hooks.ts';
import { Nav } from './Nav.tsx';
import { NewSessionDialog } from './NewSession.tsx';
import { useNoteData } from './note-data.ts';
import { delivered, type PendingPrompt } from './pending.ts';
import { plain } from './plain.ts';
import { updatePrefs, usePrefs } from './prefs.ts';
import { reviewGone, reviewRowText } from './review-rows.ts';
import { isQuiet, keepNote, matchesFilter } from './session-list.ts';
import {
  activeAt,
  arrangeGroups,
  groupSessions,
  PINNED_GROUP,
  REVIEWS_GROUP,
  reviewDone,
  SORT_OPTIONS,
} from './sessions.ts';
import { sessionSuggestions } from './slash-commands.ts';
import { age, clock } from './time.ts';
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

/** A row in the live list, faded while a re-sort moves it. */
function ListItem({ moving, children }: { moving?: 'leaving' | 'arriving'; children: ReactNode }) {
  return (
    <div className={moving ? `joc-slist__item is-${moving}` : 'joc-slist__item'} role="none">
      {children}
    </div>
  );
}

/** The row's time: the clock it started at under First seen, else how long ago it last acted. */
function timeOf(s: Session, sort: string, now: number): string {
  if (sort === 'seen') return clock(s.startedAt, now);
  if (sort === 'activity') return age(new Date(activeAt(s)).toISOString(), now);
  return age(s.updatedAt, now);
}

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

/** The session header's actions: how a delete stands, and the menu with Delete in it. */
function SessionActions({
  session,
  line,
  now,
  onDelete,
}: {
  session: Session;
  line?: { text: string; failed: boolean };
  now: number;
  onDelete: () => void;
}) {
  return (
    <>
      {line ? (
        <span className={line.failed ? 'app-shead__status is-failed' : 'app-shead__status'}>
          {line.failed ? <CIMark status="fail" size={12} /> : null}
          {line.text}
        </span>
      ) : null}
      <OverflowMenu
        label="Session actions"
        items={[
          {
            id: 'delete',
            label: 'Delete session…',
            icon: 'trash',
            danger: true,
            disabledReason: cantDelete(session, now),
            onSelect: onDelete,
          },
        ]}
      />
    </>
  );
}

export default function App() {
  const { sessions, connected, deleted } = useSessions();
  const deletes = useDeletes();
  // The session whose delete is being confirmed.
  const [deleting, setDeleting] = useState<Session>();
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
  // A deleted session stays where it was in the list, faded; nothing is selected in its place.
  const gone = selected && deleted.has(selected.id) ? selected : undefined;
  const keep = useSessionSettings();
  // The repo a new session is being started on.
  const [newIn, setNewIn] = useState<string>();
  useReadWhileViewing(useNoteData().alerts, selected?.id);
  const items = useConversation(selected?.id);
  const changes = useChanges(selected?.id);
  const commands = useCommands(selected?.id);
  const dockRef = useCmdlistMax();
  // What the composer suggests on `/`: the session's own commands, the built-ins until then.
  const slash = selected ? sessionSuggestions(selected, commands) : undefined;
  const tasks = selected ? backgroundTasks(items, selected.state, selected.background) : [];
  const running = runningCount(tasks);
  const [tab, setTab] = useState('conversation');
  // The Changes tab needs the width, so the session list folds into a rail of state dots.
  const [listOpen, setListOpen] = useState(false);
  // You can also fold it on any tab; that choice, the groups you folded and the sessions you
  // pinned to the top (in the order you pinned them) are remembered.
  const {
    listFolded,
    foldedGroups: folded,
    pinned,
    sessionSort: sort,
    dismissedReviews: dismissed,
  } = usePrefs();
  const railed = listFolded || (tab === 'changes' && !listOpen);
  const github = useGitHub();
  const prs = github?.state === 'reported' ? [...github.reviewRequested, ...github.mine] : [];
  // The list holds its order while the pointer or keyboard focus is in it, or its sort menu is
  // open; it re-sorts once it's left alone (see held-order.ts).
  const [pointerIn, setPointerIn] = useState(false);
  const [focusIn, setFocusIn] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const held = pointerIn || focusIn || sortOpen;
  // Finished reviews you cleared, or that finished a while ago, leave the list.
  const target = groupSessions(
    shown.filter((s) => !reviewGone(s, dismissed, now)),
    pinned,
    sort,
  );
  const targetIds = target.flatMap((g) => g.sessions.map((s) => s.id));
  /** The groups as shown for a held order: a review due to leave stays until the next settle. */
  const arrange = (order: string[]) => {
    const due = new Set(targetIds);
    const keep = new Set(order);
    const list = shown.filter(
      (s) => due.has(s.id) || (keep.has(s.id) && !dismissed.includes(s.id)),
    );
    return arrangeGroups(groupSessions(list, pinned, sort), order);
  };
  const resort = useHeldOrder(
    targetIds,
    (order) => arrange(order).flatMap((g) => g.sessions.map((s) => s.id)),
    held,
    // Applied at once: you asked for these.
    [sort, filter, pinned.join(), dismissed.join()].join('|'),
  );
  const groups = arrange(resort.order);
  const moving = (id: string) =>
    resort.leaving.has(id) ? 'leaving' : resort.arriving.has(id) ? 'arriving' : undefined;
  const reviewGroup = groups.find((g) => g.id === REVIEWS_GROUP);
  const finishedReviews = reviewGroup?.sessions.filter(reviewDone) ?? [];
  const reviewRow = (s: Session) => {
    const text = reviewRowText(s, prs, activityOf(s, now), now);
    return text
      ? {
          id: s.id,
          state: s.state,
          done: text.done,
          title: text.title,
          pr: text.pr,
          prTitle: text.prTitle,
          activity: text.activity,
          time: text.time,
          outcome: s.review?.outcome,
          selected: s.id === selected?.id && !gone,
        }
      : undefined;
  };
  const dismiss = (ids: string[]) =>
    updatePrefs({ dismissedReviews: [...dismissed, ...ids].slice(-MAX_PREF_ITEMS) });
  const [pending, setPending] = useState<PendingPrompt[]>([]);
  // A sent prompt shows until the session's own transcript has it.
  const waiting = pending.filter((p) => p.sessionId === selected?.id && !delivered(items, p));

  /** Where the session's delete stands, while one is under way or after it failed. */
  function deletingLine(s: Session): { text: string; failed: boolean } | undefined {
    const deletion = deletionOf(deletes, s.id);
    const text = deletion && deletionLine(deletion, machineLive(sessions, deletion.machine, now));
    return text ? { text, failed: deletion?.status === 'failed' } : undefined;
  }

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
              reviews={(reviewGroup?.sessions ?? []).flatMap((s) => reviewRow(s) ?? [])}
              onSelectReview={(r) => r.id && setSelectedId(r.id)}
              groups={groups
                .filter((g) => g.id !== REVIEWS_GROUP)
                .map((g) => ({
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
          <aside
            className="joc-app__side"
            onPointerEnter={() => setPointerIn(true)}
            onPointerLeave={() => setPointerIn(false)}
            // Keyboard focus holds the order; a click that leaves focus on a row doesn't.
            onFocus={(e) => setFocusIn(e.target.matches(':focus-visible'))}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget)) setFocusIn(false);
            }}
          >
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
            <SortBar
              value={sort}
              options={SORT_OPTIONS}
              onChange={(sessionSort) => updatePrefs({ sessionSort })}
              held={held}
              waiting={resort.waiting}
              note="Applies to every repo group"
              onOpenChange={setSortOpen}
              // A no-break space every other time, so each settle is read out again.
              announcement={
                resort.settles ? `Sessions re-sorted${resort.settles % 2 ? '' : ' '}` : undefined
              }
            />
            <div className="app-side__list" role="listbox" aria-label="Sessions">
              {groups.map((g) => (
                <Fragment key={g.id}>
                  <RepoGroupHeader
                    repo={g.label}
                    kind={g.id === REVIEWS_GROUP ? 'reviews' : 'repo'}
                    count={g.sessions.length}
                    needs={g.sessions.filter((s) => s.state === 'needs').length}
                    pinned={g.id === PINNED_GROUP}
                    collapsed={folded.includes(g.id)}
                    action={
                      g.id === REVIEWS_GROUP && finishedReviews.length
                        ? {
                            label: `Clear ${finishedReviews.length} finished`,
                            onClick: () => dismiss(finishedReviews.map((s) => s.id)),
                          }
                        : undefined
                    }
                    onToggle={() =>
                      updatePrefs({ foldedGroups: toggled(folded, g.id, !folded.includes(g.id)) })
                    }
                  />
                  {/* Pinned never folds: its header isn't a toggle. */}
                  {g.id !== PINNED_GROUP && folded.includes(g.id) ? null : (
                    <>
                      {g.sessions.map((s) => {
                        const review = g.id === REVIEWS_GROUP ? reviewRow(s) : undefined;
                        return (
                          <ListItem key={s.id} moving={moving(s.id)}>
                            {review ? (
                              <ReviewSessionRow
                                {...review}
                                onSelect={() => setSelectedId(s.id)}
                                onDismiss={review.done ? () => dismiss([s.id]) : undefined}
                              />
                            ) : (
                              <SessionRow
                                state={s.state}
                                title={s.title ?? UNTITLED}
                                branch={s.branch}
                                worktree={s.worktree}
                                contextLeft={s.contextLeft}
                                activity={activityOf(s, now)}
                                time={timeOf(s, sort, now)}
                                quiet={quietOf(s, now)}
                                selected={s.id === selected?.id && !gone}
                                removed={deleted.has(s.id) ? removedLine(s.machine) : undefined}
                                pinned={g.id === PINNED_GROUP}
                                onSelect={() => setSelectedId(s.id)}
                                onPinChange={(on) =>
                                  updatePrefs({ pinned: toggled(pinned, s.id, on) })
                                }
                              />
                            )}
                          </ListItem>
                        );
                      })}
                      {filtering || g.id === PINNED_GROUP || g.id === REVIEWS_GROUP ? null : (
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
                          worktree={s.worktree}
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
          {gone ? (
            <EmptyState
              title="Session deleted"
              body={`It's gone from ${gone.machine ?? 'its machine'} and from JOC. Pick another session from the list.`}
            />
          ) : selected ? (
            <>
              <SessionHeader
                title={selected.title ?? UNTITLED}
                state={selected.state}
                repo={selected.repo}
                branch={selected.branch}
                worktree={selected.worktree}
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
              >
                <SessionActions
                  session={selected}
                  line={deletingLine(selected)}
                  now={now}
                  onDelete={() => setDeleting(selected)}
                />
              </SessionHeader>
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
                  <div className="app-main__dock" ref={dockRef}>
                    {/* One composer whether or not the session is online, so going offline keeps
                        what you typed. */}
                    <Composer
                      key={selected.id}
                      disabled={selected.state === 'offline'}
                      hint={
                        selected.state === 'offline'
                          ? 'Session went offline. You can send again when it reconnects.'
                          : undefined
                      }
                      placeholder={selected.state === 'offline' ? 'Session is offline' : undefined}
                      working={selected.state === 'working'}
                      imageLimits={IMAGE_LIMITS}
                      suggestions={slash?.suggestions}
                      commandsStatus={slash?.status}
                      onSubmit={(text, images) => void send(selected.id, text, images)}
                    />
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
      {deleting ? (
        <DeleteDialog
          sessions={[deleting]}
          onAsked={() => setDeleting(undefined)}
          onClose={() => setDeleting(undefined)}
        />
      ) : null}
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

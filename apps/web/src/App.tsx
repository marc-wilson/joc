import {
  arrangeTeam,
  IMAGE_TYPES,
  ImageRef,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  MAX_PREF_ITEMS,
  PromptQueued,
  type Session,
  type Teammate,
} from '@joc/protocol';
import {
  Button,
  CIMark,
  Composer,
  EmptyState,
  NewSessionButton,
  OverflowMenu,
  QueueNote,
  RepoGroupHeader,
  ReviewSessionRow,
  SessionHeader,
  SessionListFooter,
  SessionListNote,
  SessionRail,
  SessionRow,
  type SessionRowProps,
  SessionTeammate,
  SessionTeammates,
  SortBar,
  TEAMMATE_LABEL,
  TeamChip,
  TeamGlance,
  TextInput,
  TextLink,
} from '@joc/ui';
import { Fragment, type ReactNode, useEffect, useState } from 'react';
import { apiFetch } from './auth.ts';
import { BackgroundView } from './Background.tsx';
import { backgroundTasks, runningCount, runningLine, withoutTeammates } from './background.ts';
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
  usePromptStatuses,
  useReadWhileViewing,
  useResumes,
  useSessionSettings,
  useSessions,
  useToastClearance,
} from './hooks.ts';
import { Nav } from './Nav.tsx';
import { NewSessionDialog } from './NewSession.tsx';
import { useNoteData } from './note-data.ts';
import {
  arrived,
  type PendingPrompt,
  type PendingView,
  pendingViews,
  queueLine,
} from './pending.ts';
import { plain } from './plain.ts';
import { updatePrefs, usePrefs } from './prefs.ts';
import { useResumeView } from './Resuming.tsx';
import { ReviewPanel, ReviewTab, ReviewVerdict, useSessionReview } from './ReviewPR.tsx';
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
import { TeamTab } from './Team.tsx';
import { sessionTeam, shortElapsed, teamCounts, teamLine } from './team.ts';
import { age, ago, clock } from './time.ts';
import { toggled } from './toggled.ts';

const UNTITLED = 'New session';

const FILTER_ID = 'session-filter';

/** Claude Code's list types that are teammates, which the Team tab counts instead. */
const TEAMMATE_TYPES = ['subagent', 'teammate', 'agent'];

/** The row's activity line: what Claude is doing, or, once it stopped reporting, what it last did. */
function activityOf(s: Session, now: number, team: Teammate[] = s.team ?? []): string | undefined {
  // Work running on in the background is counted from Claude Code's list, as the tab counts it;
  // teammates have a line of their own.
  const running = s.background?.tasks.filter((t) => !TEAMMATE_TYPES.includes(t.type)).length ?? 0;
  const waitingOnTeam = s.state !== 'working' && s.state !== 'needs' ? teamLine(team) : undefined;
  const activity =
    s.state === 'background' && running
      ? runningLine(running)
      : (waitingOnTeam ?? (s.activity && plain(s.activity)));
  if (!isQuiet(s, now)) return activity;
  const silent = `No word from ${s.machine ?? 'its machine'}`;
  return activity ? `${silent} · last: ${activity}` : silent;
}

/** "Quiet 6m" for a session whose machine stopped reporting, in place of its time. */
const quietOf = (s: Session, now: number) =>
  isQuiet(s, now) ? `Quiet ${age(s.updatedAt, now)}` : undefined;

/** Nested teammate rows shown before the rest are summed up in one link. */
const NESTED_SHOWN = 5;

/** "+1 stopped", "+3 more": the teammates past the nested rows. */
function moreLine(rest: Teammate[]): string {
  const [first] = rest;
  const same = first && rest.every((t) => t.status === first.status);
  return `+${rest.length} ${same ? TEAMMATE_LABEL[first.status].toLowerCase() : 'more'} · open Team`;
}

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
  onResume,
}: {
  session: Session;
  line?: { text: string; failed: boolean };
  now: number;
  onDelete: () => void;
  /** Resume, for an ended session that can be resumed now. */
  onResume?: () => void;
}) {
  return (
    <>
      {line ? (
        <span className={line.failed ? 'app-shead__status is-failed' : 'app-shead__status'}>
          {line.failed ? <CIMark status="fail" size={12} /> : null}
          {line.text}
        </span>
      ) : null}
      {onResume ? (
        <Button variant="secondary" size="sm" onClick={onResume}>
          Resume
        </Button>
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

/**
 * A lead session's row with what its teammates add: the team chip, the toggle under its dot,
 * and its teammates under it while you keep them open (only you open them).
 */
function LeadRow({
  session,
  team,
  open,
  onOpenChange,
  onMate,
  now,
  row,
}: {
  session: Session;
  team: Teammate[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMate: (id?: string) => void;
  now: number;
  row: SessionRowProps;
}) {
  if (!team.length) return <SessionRow {...row} />;
  const { active, failed } = teamCounts(team);
  const { active: live, finished: ended } = arrangeTeam(team);
  const ordered = [...live, ...ended];
  const shown = ordered.slice(0, NESTED_SHOWN);
  const rest = ordered.slice(NESTED_SHOWN);
  return (
    <>
      <SessionRow
        {...row}
        team={<TeamChip active={active} total={team.length} failed={failed} />}
        teammates={{ open, onToggle: () => onOpenChange(!open) }}
      />
      {open ? (
        <SessionTeammates
          more={rest.length ? { label: moreLine(rest), onClick: () => onMate() } : undefined}
        >
          {shown.map((t) => (
            <SessionTeammate
              key={t.id}
              status={t.status}
              title={t.title}
              issue={t.issue}
              time={
                t.startedAt
                  ? shortElapsed(
                      t.startedAt,
                      t.endedAt ?? (session.state === 'offline' ? t.startedAt : now),
                    )
                  : undefined
              }
              onSelect={() => onMate(t.id)}
            />
          ))}
        </SessionTeammates>
      ) : null}
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
  // A notification opened here changes the address instead of loading the page again.
  useEffect(() => {
    const follow = () => {
      const id = new URLSearchParams(location.search).get('session');
      if (id) setSelectedId(id);
    };
    window.addEventListener('popstate', follow);
    return () => window.removeEventListener('popstate', follow);
  }, []);
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
  const changes = useChanges(selected?.id, !!selected?.review);
  const commands = useCommands(selected?.id);
  const dockRef = useCmdlistMax();
  const toastClear = useToastClearance();
  // What the composer suggests on `/`: the session's own commands, the built-ins until then.
  const slash = selected ? sessionSuggestions(selected, commands) : undefined;
  const tasks = selected
    ? withoutTeammates(backgroundTasks(items, selected.state, selected.background))
    : [];
  const running = runningCount(tasks);
  // The selected session's teammates, from its conversation; the others' as the server said.
  const team = selected ? sessionTeam(selected, items) : [];
  const teamOf = (s: Session) => (s.id === selected?.id ? team : (s.team ?? []));
  const liveMates = teamCounts(team).active;
  // The teammate the Team tab shows, per session.
  const [mates, setMates] = useState<Record<string, string>>({});
  const [tab, setTab] = useState('conversation');
  // A background task's call to bring into view in the conversation, once (Design gaps, #92).
  const [reveal, setReveal] = useState<string>();
  const review = useSessionReview(selected);
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
    openTeams = [],
  } = usePrefs();
  /** Opens a session's teammate in its Team tab. */
  const openMate = (sessionId: string, mateId?: string) => {
    setSelectedId(sessionId);
    if (mateId) setMates((was) => ({ ...was, [sessionId]: mateId }));
    setTab('team');
    setListOpen(false);
  };
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
    const text = reviewRowText(s, activityOf(s, now), now);
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
  // Where the selected session's prompts stand on the server: in JOC, with Claude Code, failed.
  const promptStatuses = usePromptStatuses(selected?.id);
  // Pending prompts Claude Code had when JOC tried to change them: said on the bubble.
  const [locked, setLocked] = useState<ReadonlySet<string>>(new Set());
  // A message taken back to edit, for the composer.
  const [fill, setFill] = useState<{ text: string; seq: number }>();
  // A sent prompt shows at the bottom until the session's own transcript has it; that copy then
  // takes its place, as it's the newest item there too.
  const sessionPending = pending.filter((p) => p.sessionId === selected?.id);
  const landed = arrived(items, sessionPending);
  const settled = new Set(landed.values());
  const waiting = selected
    ? pendingViews(
        sessionPending.filter((p) => !landed.has(p.id)),
        promptStatuses,
        selected.state,
      ).map((v) =>
        locked.has(v.prompt.id) && v.phase !== 'failed'
          ? { ...v, line: `${v.line} · In Claude Code's queue, can't be changed from JOC` }
          : v,
      )
    : [];
  const queued = selected ? queueLine(waiting, selected.state) : undefined;
  // An ended session's Resume, and how starting it back up goes.
  const resumes = useResumes();
  const messages = items.filter((i) => i.kind === 'user' || i.kind === 'claude').length;
  const resuming = useResumeView(selected, resumes, sessions, messages, now);

  /** Where the session's delete stands, while one is under way or after it failed. */
  function deletingLine(s: Session): { text: string; failed: boolean } | undefined {
    const deletion = deletionOf(deletes, s.id);
    const text = deletion && deletionLine(deletion, machineLive(sessions, deletion.machine, now));
    return text ? { text, failed: deletion?.status === 'failed' } : undefined;
  }

  function send(sessionId: string, text: string, files: File[] = []) {
    // Sent while this session's conversation shows: its copy comes after the newest item.
    const after = sessionId === selected?.id ? items.at(-1)?.id : undefined;
    const prompt: PendingPrompt = {
      id: crypto.randomUUID(),
      sessionId,
      text,
      images: [],
      files,
      after,
    };
    setPending((list) => [...list, prompt]);
    void post(prompt);
  }

  const updatePending = (id: string, change: Partial<PendingPrompt>) =>
    setPending((list) => list.map((p) => (p.id === id ? { ...p, ...change } : p)));

  /** Hands the prompt to the server: its images first, then the prompt naming them. */
  async function post(prompt: PendingPrompt) {
    const { id, sessionId, text, files = [] } = prompt;
    try {
      // The images first: the prompt refers to them by the ids the server gives them.
      let images = prompt.images;
      if (files.length) {
        const uploaded = (await Promise.all(files.map(uploadImage))).filter((i) => i !== undefined);
        if (uploaded.length < files.length) {
          return updatePending(id, { images: uploaded, failed: "an image didn't upload" });
        }
        images = uploaded;
        updatePending(id, { images, files: undefined });
      }
      const res = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/prompts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, images: images.map((i) => i.id) }),
      });
      if (!res.ok) return updatePending(id, { failed: 'JOC refused it' });
      const { id: serverId } = PromptQueued.parse(await res.json());
      updatePending(id, { serverId });
    } catch {
      // The server is unreachable: the prompt shows as not sent.
      updatePending(id, { failed: "the server couldn't be reached" });
    }
  }

  /** Sends a failed prompt again, in the same place. */
  function retry({ prompt }: PendingView) {
    const again = { ...prompt, serverId: undefined, failed: undefined };
    updatePending(prompt.id, { serverId: undefined, failed: undefined });
    void post(again);
  }

  /**
   * Takes a prompt back while it's still in JOC. False when the plugin took it first: Claude Code
   * has it, and JOC can't change it.
   */
  async function withdraw({ prompt }: PendingView): Promise<boolean> {
    if (!prompt.serverId) return false;
    const res = await apiFetch(
      `/api/sessions/${encodeURIComponent(prompt.sessionId)}/prompts/${encodeURIComponent(prompt.serverId)}`,
      { method: 'DELETE' },
      // Unreachable: the message stays, as if it couldn't be taken back.
    ).catch(() => undefined);
    if (res?.ok || res?.status === 404) {
      setPending((list) => list.filter((p) => p.id !== prompt.id));
      return true;
    }
    if (res?.status === 409) setLocked((was) => new Set([...was, prompt.id]));
    return false;
  }

  const pendingActions = {
    onCancel: (view: PendingView) => void withdraw(view),
    onEdit: async (view: PendingView) => {
      if (await withdraw(view)) {
        setFill((was) => ({ text: view.prompt.text, seq: (was?.seq ?? 0) + 1 }));
      }
    },
    onRetry: retry,
  };

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
                              <LeadRow
                                session={s}
                                team={teamOf(s)}
                                open={openTeams.includes(s.id)}
                                onOpenChange={(on) =>
                                  updatePrefs({
                                    openTeams: toggled(openTeams, s.id, on).slice(-MAX_PREF_ITEMS),
                                  })
                                }
                                onMate={(id) => openMate(s.id, id)}
                                now={now}
                                row={{
                                  state: s.state,
                                  title: s.title ?? UNTITLED,
                                  branch: s.branch,
                                  worktree: s.worktree,
                                  contextLeft: s.contextLeft,
                                  activity: activityOf(s, now, teamOf(s)),
                                  time: timeOf(s, sort, now),
                                  quiet: quietOf(s, now),
                                  selected: s.id === selected?.id && !gone,
                                  removed: deleted.has(s.id) ? removedLine(s.machine) : undefined,
                                  pinned: g.id === PINNED_GROUP,
                                  onSelect: () => setSelectedId(s.id),
                                  onPinChange: (on) =>
                                    updatePrefs({ pinned: toggled(pinned, s.id, on) }),
                                }}
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
                ended={resuming?.tag}
                when={
                  selected.state === 'offline' ? `Ended ${ago(selected.updatedAt, now)}` : undefined
                }
                repo={selected.repo}
                branch={selected.branch}
                worktree={selected.worktree}
                machine={selected.machine}
                model={selected.model}
                contextLeft={selected.contextLeft}
                glance={
                  <TeamGlance
                    statuses={(() => {
                      const { active, finished } = arrangeTeam(team);
                      return [...active, ...finished].map((t) => t.status);
                    })()}
                    onClick={() => openMate(selected.id)}
                  />
                }
                tabs={[
                  { id: 'conversation', label: 'Conversation' },
                  ...(selected.review
                    ? [{ id: 'pr', label: `PR #${selected.review.number}` }]
                    : []),
                  {
                    // Always there, so the tabs never shift; counted once a teammate is at work.
                    id: 'team',
                    label: 'Team',
                    count: liveMates || undefined,
                    countLabel: liveMates ? `${liveMates} active` : undefined,
                  },
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
                  onResume={resuming?.canResume ? resuming.resume : undefined}
                />
              </SessionHeader>
              {tab === 'pr' && selected.review ? (
                <ReviewTab
                  key={selected.id}
                  session={selected}
                  items={items}
                  review={review}
                  onOpenChanges={() => setTab('changes')}
                />
              ) : tab === 'background' ? (
                <BackgroundView
                  key={selected.id}
                  sessionId={selected.id}
                  tasks={tasks}
                  onReveal={(id) => {
                    setReveal(id);
                    setTab('conversation');
                  }}
                />
              ) : tab === 'team' ? (
                <TeamTab
                  key={selected.id}
                  sessionId={selected.id}
                  repo={selected.repo}
                  team={team}
                  items={items}
                  prs={prs}
                  selected={mates[selected.id]}
                  onSelect={(id) => setMates((was) => ({ ...was, [selected.id]: id }))}
                  onDraft={(text) => {
                    setFill((was) => ({ text, seq: (was?.seq ?? 0) + 1 }));
                    setTab('conversation');
                  }}
                />
              ) : tab === 'changes' ? (
                <ChangesView
                  key={selected.id}
                  sessionId={selected.id}
                  changes={changes}
                  onSend={(text) => {
                    send(selected.id, text);
                    setTab('conversation');
                  }}
                />
              ) : (
                <>
                  <ReviewPanel
                    key={`pr-${selected.id}`}
                    session={selected}
                    items={items}
                    review={review}
                    onSend={(text) => send(selected.id, text)}
                  />
                  <Conversation
                    key={selected.id}
                    sessionId={selected.id}
                    items={items}
                    pending={waiting}
                    pendingActions={pendingActions}
                    settled={settled}
                    state={selected.state}
                    session={selected}
                    divider={resuming?.divider}
                    reveal={reveal}
                    onRevealed={() => setReveal(undefined)}
                    after={
                      <ReviewVerdict
                        session={selected}
                        items={items}
                        review={review}
                        onSend={(text) => send(selected.id, text)}
                      />
                    }
                  />
                  <div
                    className="app-main__dock"
                    ref={(el) => {
                      dockRef(el);
                      toastClear(el);
                    }}
                  >
                    {queued ? <QueueNote>{queued}</QueueNote> : null}
                    {/* One composer whether or not the session is online, so going offline keeps
                        what you typed. */}
                    <Composer
                      key={selected.id}
                      disabled={selected.state === 'offline'}
                      resume={resuming?.composer}
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
                      fill={fill}
                      onSubmit={(text, images) => send(selected.id, text, images)}
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

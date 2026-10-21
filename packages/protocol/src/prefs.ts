import { z } from 'zod';

// The person's dashboard preferences, kept per owner on the server so they follow them to every
// browser (`GET`/`PATCH /api/prefs`). Bounded, so the stored document can't grow without end.

/** Sessions with their own folds and viewed files; past this the least recently changed go. */
export const MAX_PREF_SESSIONS = 50;
/** Entries in any one list: pins, folded groups, a session's folded messages or files. */
export const MAX_PREF_ITEMS = 200;

const Entry = z.string().min(1).max(500);
const Entries = z.array(Entry).max(MAX_PREF_ITEMS);

export const DiffMode = z.enum(['unified', 'split']);
export type DiffMode = z.infer<typeof DiffMode>;

/** What the person folded and viewed in one session. */
export const SessionPrefs = z.object({
  id: z.string().min(1).max(200),
  /** When it last changed (ms since the epoch), so the stalest go first past the cap. */
  at: z.number(),
  /** Claude's messages folded in the conversation. */
  foldedMessages: Entries,
  /** Changed files marked viewed (each folds unless opened again). */
  viewedFiles: Entries,
  /** Files folded by their chevron. */
  foldedFiles: Entries,
  /** Viewed files opened again by their chevron. */
  openedFiles: Entries,
});
export type SessionPrefs = z.infer<typeof SessionPrefs>;

/**
 * A kind of notification, as the settings name it. Only these notify:
 *
 * - `question`, `permission`: a session waits on you. Resolves when it's answered anywhere.
 * - `review`: your review is requested on a pull request. Resolves when the pull request leaves
 *   your review-requested list (you reviewed it, the request was removed, it closed).
 * - `mention`: a mention, or a comment on your pull request. Resolves when you open it.
 * - `ci-failed`: CI failed on your pull request. Resolves when CI passes again or you open it.
 * - `long-turn`: a session finished a turn that took over LONG_TURN_MS. Off by default;
 *   resolves when you open the session.
 *
 * `finished` (every turn's end) and `github` (other GitHub activity) no longer notify; they stay
 * in the enum only so prefs stored before still parse.
 */
export const NotificationKind = z.enum([
  'question',
  'permission',
  'review',
  'mention',
  'ci-failed',
  'long-turn',
  'finished',
  'github',
]);
export type NotificationKind = z.infer<typeof NotificationKind>;

/** The kinds that notify, in the settings' order. */
export const NOTIFYING_KINDS: readonly NotificationKind[] = [
  'question',
  'permission',
  'long-turn',
  'review',
  'mention',
  'ci-failed',
];

/** A turn longer than this raises a `long-turn` notification when it ends. */
export const LONG_TURN_MS = 10 * 60_000;

/**
 * Where one kind shows up, and whether its arrival chimes. All off keeps it in the history only.
 * `sound` was added later: a stored choice without it has the kind's default.
 */
export const NotificationChannels = z.object({
  panel: z.boolean(),
  toast: z.boolean(),
  desktop: z.boolean(),
  sound: z.boolean().optional(),
});
export type NotificationChannels = z.infer<typeof NotificationChannels>;

/** NotificationChannels with every channel spelt out. */
export type Channels = Required<NotificationChannels>;

/** Kinds always in the panel: a session waiting on you never hides. */
export const PINNED_KINDS: readonly NotificationKind[] = ['question', 'permission'];

const OFF: Channels = { panel: false, toast: false, desktop: false, sound: false };

export const DEFAULT_NOTIFICATION_CHANNELS: Record<NotificationKind, Channels> = {
  question: { panel: true, toast: true, desktop: true, sound: true },
  permission: { panel: true, toast: true, desktop: true, sound: true },
  review: { panel: true, toast: true, desktop: true, sound: false },
  mention: { panel: true, toast: false, desktop: false, sound: false },
  'ci-failed': { panel: true, toast: false, desktop: false, sound: false },
  'long-turn': OFF,
  finished: OFF,
  github: OFF,
};

/**
 * How the session list orders the sessions in each group: by state (needs you first), last
 * activity (newest first), name (A to Z) or first seen (earliest first).
 */
export const SessionSort = z.enum(['state', 'activity', 'name', 'seen']);
export type SessionSort = z.infer<typeof SessionSort>;

/** The notification panel's filter. */
export const NotificationTab = z.enum(['all', 'needs', 'github']);
export type NotificationTab = z.infer<typeof NotificationTab>;

export const Prefs = z.object({
  /**
   * Desktop notifications are wanted (for the kinds set to Desktop). Each browser still has to
   * allow them itself.
   */
  browserNotifications: z.boolean(),
  /** Only while JOC isn't the focused window. */
  desktopWhenAway: z.boolean(),
  /** The arrival chime, for the kinds set to Sound. */
  notificationSound: z.boolean(),
  /** Where each kind of notification shows up; a kind left out has its default. */
  notificationKinds: z.partialRecord(NotificationKind, NotificationChannels),
  /** The panel's last filter. */
  notificationTab: NotificationTab,
  /** Sessions pinned to the top of the list, in the order they were pinned. */
  pinned: Entries,
  /** Session list groups folded. */
  foldedGroups: Entries,
  /** The session list folded into its rail. */
  listFolded: z.boolean(),
  /** How the session list orders each group. */
  sessionSort: SessionSort,
  /** Finished reviews cleared from the list (they stay in the history), oldest first. */
  dismissedReviews: Entries,
  diffMode: DiffMode,
  /** The Background tab lists every finished task, not just the latest few. */
  showAllFinishedTasks: z.boolean(),
  /** The plugin version whose out-of-date banner was dismissed. */
  dismissedPluginBanner: z.string().max(100).optional(),
  /** The sessions on an old plugin copy whose reload banner was dismissed (`staleKey`). */
  dismissedReloadBanner: z.string().max(10_000).optional(),
  sessions: z.array(SessionPrefs).max(MAX_PREF_SESSIONS),
});
export type Prefs = z.infer<typeof Prefs>;

export const DEFAULT_PREFS: Prefs = {
  browserNotifications: false,
  desktopWhenAway: true,
  notificationSound: true,
  notificationKinds: {},
  notificationTab: 'all',
  pinned: [],
  foldedGroups: [],
  listFolded: false,
  sessionSort: 'state',
  dismissedReviews: [],
  diffMode: 'unified',
  showAllFinishedTasks: false,
  sessions: [],
};

/** A change to one session's prefs: the lists given replace the stored ones. */
export const SessionPrefsPatch = SessionPrefs.omit({ at: true }).partial().required({ id: true });
export type SessionPrefsPatch = z.infer<typeof SessionPrefsPatch>;

/** `PATCH /api/prefs`: the fields given replace the stored ones; sessions merge by id. */
export const PrefsPatch = Prefs.omit({ sessions: true })
  .partial()
  .extend({ sessions: z.array(SessionPrefsPatch).max(MAX_PREF_SESSIONS).optional() });
export type PrefsPatch = z.infer<typeof PrefsPatch>;

/** `GET /api/prefs`. `saved` is false until the person's first change was stored. */
export const PrefsSnapshot = z.object({ saved: z.boolean(), prefs: Prefs });
export type PrefsSnapshot = z.infer<typeof PrefsSnapshot>;

const SESSION_LISTS = ['foldedMessages', 'viewedFiles', 'foldedFiles', 'openedFiles'] as const;

/** `value` without its undefined fields, so spreading it leaves those as they were. */
const given = <T extends object>(value: T): Partial<T> =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;

const isEmpty = (s: SessionPrefs) => SESSION_LISTS.every((k) => s[k].length === 0);

/**
 * `prefs` with `patch` applied at `now`. A session left with nothing folded or viewed is dropped,
 * and past `MAX_PREF_SESSIONS` the least recently changed go.
 */
export function applyPrefsPatch(prefs: Prefs, patch: PrefsPatch, now: number): Prefs {
  const { sessions: changes, ...top } = patch;
  const sessions = [...prefs.sessions];
  for (const change of changes ?? []) {
    const at = sessions.findIndex((s) => s.id === change.id);
    const before: SessionPrefs = sessions[at] ?? {
      id: change.id,
      at: now,
      foldedMessages: [],
      viewedFiles: [],
      foldedFiles: [],
      openedFiles: [],
    };
    const next: SessionPrefs = { ...before, ...given(change), at: now };
    if (at >= 0) sessions.splice(at, 1);
    if (!isEmpty(next)) sessions.push(next);
  }
  const kept = sessions.sort((a, b) => a.at - b.at).slice(-MAX_PREF_SESSIONS);
  return { ...prefs, ...given(top), sessions: kept };
}

/**
 * Where a kind shows up: the person's choice or the default; pinned kinds always in the panel.
 * The kinds that no longer notify are off whatever was stored for them.
 */
export function channelsOf(prefs: Prefs, kind: NotificationKind): Channels {
  if (!NOTIFYING_KINDS.includes(kind)) return OFF;
  const fallback = DEFAULT_NOTIFICATION_CHANNELS[kind];
  const chosen = prefs.notificationKinds[kind];
  const channels = chosen ? { ...chosen, sound: chosen.sound ?? fallback.sound } : fallback;
  return PINNED_KINDS.includes(kind) ? { ...channels, panel: true } : channels;
}

/** Whether a kind's arrival chimes: its Sound choice, under the master switch. */
export const chimes = (prefs: Prefs, kind: NotificationKind) =>
  prefs.notificationSound && channelsOf(prefs, kind).sound;

/** Two pending patches as one, the later winning field by field and session by session. */
export function combinePrefsPatches(first: PrefsPatch, later: PrefsPatch): PrefsPatch {
  const sessions = [...(first.sessions ?? [])];
  for (const change of later.sessions ?? []) {
    const at = sessions.findIndex((s) => s.id === change.id);
    if (at >= 0) sessions[at] = { ...sessions[at], ...given(change), id: change.id };
    else sessions.push(change);
  }
  const combined: PrefsPatch = { ...first, ...given(later) };
  if (sessions.length) combined.sessions = sessions;
  return combined;
}

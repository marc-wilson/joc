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
 * A kind of notification, as the settings name it. `question` and `permission` are a session
 * waiting on you; the rest are JOC's alerts and the person's GitHub notifications.
 */
export const NotificationKind = z.enum([
  'question',
  'permission',
  'finished',
  'review',
  'mention',
  'ci-failed',
  'github',
]);
export type NotificationKind = z.infer<typeof NotificationKind>;

/** Where one kind shows up. All off keeps it in the history only. */
export const NotificationChannels = z.object({
  panel: z.boolean(),
  toast: z.boolean(),
  desktop: z.boolean(),
});
export type NotificationChannels = z.infer<typeof NotificationChannels>;

/** Kinds always in the panel: a session waiting on you never hides. */
export const PINNED_KINDS: readonly NotificationKind[] = ['question', 'permission'];

export const DEFAULT_NOTIFICATION_CHANNELS: Record<NotificationKind, NotificationChannels> = {
  question: { panel: true, toast: true, desktop: true },
  permission: { panel: true, toast: true, desktop: true },
  finished: { panel: true, toast: false, desktop: false },
  review: { panel: true, toast: true, desktop: false },
  mention: { panel: true, toast: false, desktop: false },
  'ci-failed': { panel: true, toast: true, desktop: true },
  github: { panel: true, toast: false, desktop: false },
};

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
  notificationKinds: {},
  notificationTab: 'all',
  pinned: [],
  foldedGroups: [],
  listFolded: false,
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

/** Where a kind shows up: the person's choice or the default; pinned kinds always in the panel. */
export function channelsOf(prefs: Prefs, kind: NotificationKind): NotificationChannels {
  const chosen = prefs.notificationKinds[kind] ?? DEFAULT_NOTIFICATION_CHANNELS[kind];
  return PINNED_KINDS.includes(kind) ? { ...chosen, panel: true } : chosen;
}

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

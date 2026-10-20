// What the composer's command list shows for what's typed: which commands match, in what order,
// under which group, and which part of each name to mark. Pure, so it's tested in Node.

/** Whether the session's own commands are in: built-ins show while the rest load. */
export type CommandsStatus = 'loading' | 'ready' | 'offline';

/** Where a suggested command comes from; a skill says whose it is with `scope`. */
export type SuggestionSource = 'builtin' | 'project' | 'user' | 'plugin' | 'skill';

/** One slash command the composer can suggest. */
export interface ComposerSuggestion {
  /** Without the slash, and without a plugin's `plugin:` prefix. */
  name: string;
  /** The plugin that adds it. */
  plugin?: string;
  /** Drawn dim after the name, e.g. `<pr>`. */
  args?: string;
  description: string;
  source: SuggestionSource;
  /** A skill's: the project's or the user's. */
  scope?: 'project' | 'user';
}

/** One row of the list. */
export interface SuggestionRow {
  command: ComposerSuggestion;
  /** What completing it inserts: `plugin:name` for a plugin's, so it runs unambiguously. */
  insert: string;
  /** The name as shown: `name`, or `plugin:name` where two plugins share the name. */
  shown: string;
  /** The `plugin:` prefix, drawn dimmer; empty unless two plugins share the name. */
  ns: string;
  /** The name split around the part that matched what's typed. */
  pre: string;
  hit: string;
  post: string;
  /** The group header above this row, on the first row of each group; only with nothing typed. */
  group?: string;
  /** The source column: Built-in, Project, a plugin's name. */
  label: string;
}

const ORDER: Record<SuggestionSource, number> = {
  builtin: 0,
  project: 1,
  user: 2,
  plugin: 3,
  skill: 4,
};

const GROUP: Record<SuggestionSource, string> = {
  builtin: 'Built-in',
  project: 'Project',
  user: 'User',
  plugin: 'Plugins',
  skill: 'Skills',
};

const LABEL: Record<Exclude<SuggestionSource, 'plugin' | 'skill'>, string> = {
  builtin: 'Built-in',
  project: 'Project',
  user: 'User',
};

export function sourceLabel(c: ComposerSuggestion): string {
  if (c.source === 'plugin') return c.plugin ?? 'Plugin';
  if (c.source === 'skill') return c.scope ? `Skill · ${c.scope}` : 'Skill';
  return LABEL[c.source];
}

/**
 * The text after `/` while a command is being typed (`/reload-p` → `reload-p`); undefined once
 * there's a space or newline, or the text isn't a command.
 */
export function slashQuery(text: string): string | undefined {
  if (!text.startsWith('/')) return undefined;
  const q = text.slice(1);
  return /\s/.test(q) ? undefined : q;
}

/**
 * The rows for what's typed after `/`. Nothing typed: every command, grouped by source in a
 * fixed order. Typing: a flat list, prefix matches on the name first, then on `plugin:name`,
 * then anywhere in the name; source order and the session's own order break ties.
 */
export function matchSuggestions(
  commands: readonly ComposerSuggestion[],
  typed: string,
): SuggestionRow[] {
  const q = typed.toLowerCase();
  const shared = new Map<string, number>();
  for (const c of commands) {
    if (c.plugin) shared.set(c.name, (shared.get(c.name) ?? 0) + 1);
  }
  const found: { row: SuggestionRow; rank: number; index: number }[] = [];
  commands.forEach((command, index) => {
    const name = command.name;
    const lower = name.toLowerCase();
    const full = command.plugin ? `${command.plugin}:${name}` : name;
    const fullLower = full.toLowerCase();
    let rank = -1;
    let at = -1;
    let length = q.length;
    if (q.includes(':')) {
      if (fullLower.startsWith(q)) {
        rank = 0;
        at = 0;
        length = q.slice(q.lastIndexOf(':') + 1).length;
      }
    } else if (lower.startsWith(q)) {
      rank = 0;
      at = 0;
    } else if (fullLower.startsWith(q)) {
      rank = 1;
    } else if (q && lower.indexOf(q) > 0) {
      rank = 2;
      at = lower.indexOf(q);
    }
    if (rank < 0) return;
    const ambiguous = !!command.plugin && (shared.get(name) ?? 0) > 1;
    const split = at >= 0 && length > 0;
    found.push({
      rank,
      index,
      row: {
        command,
        insert: full,
        shown: ambiguous ? full : name,
        ns: ambiguous ? `${command.plugin}:` : '',
        pre: split ? name.slice(0, at) : name,
        hit: split ? name.slice(at, at + length) : '',
        post: split ? name.slice(at + length) : '',
        label: sourceLabel(command),
      },
    });
  });
  found.sort(
    (a, b) =>
      (q ? a.rank - b.rank : 0) ||
      ORDER[a.row.command.source] - ORDER[b.row.command.source] ||
      a.index - b.index,
  );
  let last: SuggestionSource | undefined;
  return found.map(({ row }) => {
    const source = row.command.source;
    const group = !q && source !== last ? GROUP[source] : undefined;
    last = source;
    return group ? { ...row, group } : row;
  });
}

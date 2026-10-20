// The session's slash commands as the dashboard's composer suggests them (SlashCommand in
// @joc/protocol). register.ts gathers what the engine says: `$.command.list()` for what can run,
// and the `command.describe` events, which carry each command's argument hint, whether the
// typeahead hides it, and whose it is (the engine's, the project's, the user's, a plugin's).
// Pure, so it's tested in Node; register.ts does the reading and sending.
import type { SlashCommand } from '@joc/protocol';

/** One entry of `$.command.list()`. */
export interface ListedCommand {
  name: string;
  description: string;
  /** `builtin`, `plugin`, `user` or `mcp`; a newer engine may add more. */
  source: string;
  plugin?: string;
}

/** What a `command.describe` event said about one command. */
export interface DescribedCommand {
  argumentHint?: string;
  hidden: boolean;
}

/** Bounds from @joc/protocol, repeated: the plugin can't import its runtime code. */
const MAX_COMMANDS = 500;
const MAX_NAME = 200;
const MAX_DESCRIPTION = 500;
const MAX_HINT = 200;

/**
 * Who provides a command, by the describe event's `provider.plugin`: `engine` for a built-in,
 * `project` or `user` for the person's own, else a plugin as `name@marketplace` (`name@inline`
 * when loaded with `--plugin-dir`), kept as its name alone.
 */
export const providerOf = (plugin: string) => plugin.replace(/@[^@]*$/, '');

export const describedKey = (provider: string, command: string) => `${provider}\n${command}`;

const cut = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

/** One line: the typeahead shows only the first. */
const oneLine = (text: string) => text.split('\n')[0]?.trim() ?? '';

/**
 * The commands to suggest, in the order the engine lists them: built-in, project, user and
 * plugin commands and skills, less the ones its typeahead hides. MCP prompts are left out.
 * `skills` holds the project's and the user's commands that are skills (a `SKILL.md`), as
 * `project\nname` / `user\nname` keys.
 */
export function slashCommands(
  listed: readonly ListedCommand[],
  described: ReadonlyMap<string, DescribedCommand>,
  skills: ReadonlySet<string> = new Set(),
): SlashCommand[] {
  const out: SlashCommand[] = [];
  const seen = new Set<string>();
  for (const c of listed) {
    if (!c.name || c.name.startsWith('_') || c.name.length > MAX_NAME) continue;
    let provider: string;
    let source: SlashCommand['source'];
    let name = c.name;
    let plugin: string | undefined;
    if (c.source === 'builtin') {
      provider = 'engine';
      source = 'builtin';
    } else if (c.source === 'plugin') {
      plugin = c.plugin || c.name.split(':')[0] || undefined;
      if (!plugin || plugin.length > MAX_NAME) continue;
      provider = plugin;
      source = 'plugin';
      // `plugin:command`: the composer adds the prefix back only where two plugins share a name.
      if (name.startsWith(`${plugin}:`) && name.length > plugin.length + 1) {
        name = name.slice(plugin.length + 1);
      }
    } else if (c.source === 'user') {
      // The project's own `.claude` and the user's `~/.claude` both list as `user`.
      provider = described.has(describedKey('project', c.name)) ? 'project' : 'user';
      source = provider === 'project' ? 'project' : 'user';
    } else {
      continue;
    }
    const about = described.get(describedKey(provider, c.name));
    if (about?.hidden) continue;
    const key = `${source}\n${plugin ?? ''}\n${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const hint = about?.argumentHint?.trim();
    const skill = (source === 'project' || source === 'user') && skills.has(`${source}\n${c.name}`);
    out.push({
      name,
      description: cut(oneLine(c.description), MAX_DESCRIPTION),
      ...(hint ? { argumentHint: cut(argumentHint(hint), MAX_HINT) } : {}),
      source,
      ...(plugin ? { plugin: cut(plugin, MAX_NAME) } : {}),
      ...(skill ? { skill: true } : {}),
    });
    if (out.length >= MAX_COMMANDS) break;
  }
  return out;
}

/**
 * A hint as the typeahead draws it: an author's bare `since` reads as `[since]`, one already in
 * brackets or angle brackets stays as written.
 */
function argumentHint(hint: string): string {
  return /^[[<]/.test(hint) ? hint : `[${hint}]`;
}

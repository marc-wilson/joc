import type { Session, SlashCommand } from '@joc/protocol';
// The pure part of @joc/ui, so the Node tests needn't load its components.
import type { CommandsStatus, ComposerSuggestion } from '@joc/ui/slash';

/**
 * Claude Code's built-ins that only open an interactive panel in the session's terminal: sent
 * from JOC they open there, and JOC shows nothing of them.
 */
export const TERMINAL_ONLY: ReadonlySet<string> = new Set([
  'agents',
  'config',
  'doctor',
  'export',
  'help',
  'hooks',
  'ide',
  'login',
  'logout',
  'mcp',
  'memory',
  'model',
  'permissions',
  'plugin',
  'resume',
  'stats',
  'status',
  'terminal-setup',
  'theme',
  'usage',
  'vim',
]);

/** Marks a built-in that only opens in the terminal. */
function marked(c: ComposerSuggestion): ComposerSuggestion {
  return c.source === 'builtin' && TERMINAL_ONLY.has(c.name) ? { ...c, terminal: true } : c;
}

/**
 * Claude Code's own commands, which JOC knows without asking: the composer suggests these while
 * the session's own list is on its way. Once it's in, the session's list replaces them.
 */
export const BUILTIN_COMMANDS: ComposerSuggestion[] = (
  [
    { name: 'add-dir', args: '<path>', description: 'Add a working folder', source: 'builtin' },
    { name: 'clear', description: 'Clear the conversation and start fresh', source: 'builtin' },
    {
      name: 'compact',
      args: '[instructions]',
      description: 'Summarise the conversation to free up context',
      source: 'builtin',
    },
    { name: 'config', description: 'Open the settings', source: 'builtin' },
    { name: 'context', description: 'Show what is using the context window', source: 'builtin' },
    { name: 'doctor', description: 'Check the Claude Code install', source: 'builtin' },
    { name: 'help', description: 'Show help and the commands', source: 'builtin' },
    { name: 'init', description: 'Write a CLAUDE.md for this codebase', source: 'builtin' },
    { name: 'mcp', description: 'Manage MCP servers', source: 'builtin' },
    { name: 'memory', description: 'Edit the memory files', source: 'builtin' },
    {
      name: 'model',
      args: '[model]',
      description: 'Switch the model for this session',
      source: 'builtin',
    },
    { name: 'plugin', description: 'Manage plugins', source: 'builtin' },
    {
      name: 'reload-plugins',
      description: 'Reload plugins without restarting the session',
      source: 'builtin',
    },
    { name: 'rename', args: '[name]', description: 'Rename this session', source: 'builtin' },
    {
      name: 'resume',
      args: '[session]',
      description: 'Resume a previous conversation',
      source: 'builtin',
    },
    { name: 'status', description: 'Show the version, model and account', source: 'builtin' },
    { name: 'usage', description: 'Show plan usage limits', source: 'builtin' },
  ] satisfies ComposerSuggestion[]
).map(marked);

/** A command as the composer suggests it: a skill shows as one, with whose it is. */
export function suggestion(c: SlashCommand): ComposerSuggestion {
  const skill = c.skill && (c.source === 'project' || c.source === 'user');
  return marked({
    name: c.name,
    description: c.description,
    ...(c.argumentHint ? { args: c.argumentHint } : {}),
    ...(c.plugin ? { plugin: c.plugin } : {}),
    source: skill ? 'skill' : c.source,
    ...(skill ? { scope: c.source as 'project' | 'user' } : {}),
  });
}

/** The first plugin version that sends its session's commands. */
const SENDS_COMMANDS = [0, 11, 0];

/** Whether a session's plugin runs `min` or later; false when it doesn't say its version. */
export function runsAtLeast(plugin: string | undefined, min: readonly number[]): boolean {
  const parts = plugin
    ?.match(/^(\d+)\.(\d+)\.(\d+)/)
    ?.slice(1)
    .map(Number);
  if (!parts) return false;
  for (let i = 0; i < 3; i++) {
    const a = parts[i] ?? 0;
    const b = min[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/** Whether a session's plugin sends its commands, by the version it runs. */
export const sendsCommands = (plugin: string | undefined) => runsAtLeast(plugin, SENDS_COMMANDS);

/** What the composer suggests for a session, and whether its own commands are in yet. */
export function sessionSuggestions(
  session: Pick<Session, 'state' | 'plugin'>,
  reported: SlashCommand[] | undefined,
): { suggestions: ComposerSuggestion[]; status: CommandsStatus } {
  const suggestions = reported ? reported.map(suggestion) : BUILTIN_COMMANDS;
  if (session.state === 'offline') return { suggestions, status: 'offline' };
  // A plugin too old to send its list never will: the built-ins are all there is.
  if (!reported && sendsCommands(session.plugin)) return { suggestions, status: 'loading' };
  return { suggestions, status: 'ready' };
}

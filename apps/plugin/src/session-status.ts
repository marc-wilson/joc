// What the session runs on, for its Status view in JOC (SessionStatusReport in @joc/protocol):
// Claude Code's version, the model, the folder, and the MCP servers, connected or failing.
// Never the login or the email. register.ts reads the engine and the settings files; this part
// is pure, so it's tested in Node.
import type { McpServerStatus, SessionStatusReport } from '@joc/protocol';

/** Bounds from @joc/protocol, repeated: the plugin can't import its runtime code. */
const MAX_SERVERS = 100;
const MAX_NAME = 200;
const MAX_VERSION = 100;
const MAX_MODEL = 100;
const MAX_CWD = 1000;

/** One MCP tool in the context breakdown (`$.session.usage`): only its server is read. */
export interface ContextTool {
  serverName: string;
}

/** The settings files that say which MCP servers the session sets up, each as parsed JSON. */
export interface McpSettings {
  /** `~/.claude.json`: user servers, and per project its servers and choices. */
  claudeJson?: unknown;
  /** The project's `.mcp.json`. */
  mcpJson?: unknown;
  /** The user's, the project's and the project's local `settings.json`. */
  settings?: unknown[];
  /** The session's project root, as `~/.claude.json` keys its projects. */
  root: string;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const keys = (value: unknown) => Object.keys(record(value) ?? {});

const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/**
 * The MCP servers the settings set up and leave on, by name: the user's, this project's in
 * `~/.claude.json`, and those of its `.mcp.json` that are approved. Only server names are read.
 */
export function configuredServers({ claudeJson, mcpJson, settings = [], root }: McpSettings) {
  const config = record(claudeJson);
  const project = record(record(config?.projects)?.[root]);
  const layers = [project, ...settings.map(record)];
  const disabled = new Set([
    ...strings(project?.disabledMcpServers),
    ...layers.flatMap((l) => strings(l?.disabledMcpjsonServers)),
  ]);
  const approved = new Set(layers.flatMap((l) => strings(l?.enabledMcpjsonServers)));
  const all = layers.some((l) => l?.enableAllProjectMcpServers === true);
  const fromMcpJson = keys(record(mcpJson)?.mcpServers).filter((name) => all || approved.has(name));
  const names = [...keys(config?.mcpServers), ...keys(project?.mcpServers), ...fromMcpJson];
  return [...new Set(names)].filter((name) => !disabled.has(name));
}

/**
 * Each server with tools in the session is connected, with how many; one the settings set up
 * that brings none failed. Connected first, each group by name.
 */
export function mcpServers(
  tools: readonly ContextTool[],
  configured: readonly string[],
): McpServerStatus[] {
  const counts = new Map<string, number>();
  for (const { serverName } of tools) {
    if (typeof serverName !== 'string' || !serverName) continue;
    counts.set(serverName, (counts.get(serverName) ?? 0) + 1);
  }
  const byName = (a: string, b: string) => a.localeCompare(b);
  const connected = [...counts.keys()]
    .sort(byName)
    .map((name): McpServerStatus => ({ name, state: 'connected', tools: counts.get(name) ?? 0 }));
  const failed = configured
    .filter((name) => !counts.has(name))
    .sort(byName)
    .map((name): McpServerStatus => ({ name, state: 'failed' }));
  return [...connected, ...failed].filter((s) => s.name.length <= MAX_NAME).slice(0, MAX_SERVERS);
}

const cut = (text: string | undefined, max: number) =>
  text ? text.slice(0, max) || undefined : undefined;

/** The report to send, within the protocol's bounds. */
export function statusReport(
  sessionId: string,
  at: number,
  about: { version?: string; model?: string; cwd?: string; mcp: McpServerStatus[] },
): SessionStatusReport {
  const version = cut(about.version, MAX_VERSION);
  const model = cut(about.model, MAX_MODEL);
  const cwd = about.cwd && about.cwd.length <= MAX_CWD ? about.cwd : undefined;
  return {
    sessionId,
    at,
    ...(version ? { version } : {}),
    ...(model ? { model } : {}),
    ...(cwd ? { cwd } : {}),
    mcp: about.mcp,
  };
}

/** What makes two reports the same, so an unchanged status isn't sent again. */
export const statusKey = ({ at: _at, ...rest }: SessionStatusReport) => JSON.stringify(rest);

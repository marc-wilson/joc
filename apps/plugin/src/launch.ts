// Starting a new session the dashboard asked for, as `claude --bg` in this session's folder.
// What the CLI does (Claude Code 2.1):
// - `--bg` picks the session's id itself and ignores `--session-id`. It prints
//   `backgrounded · <short id> · <name>`; `claude agents --json` maps that short id to the full
//   session id, which is the id the new session's plugin reports under.
// - The session runs under Claude Code's background service, not this process, so it doesn't
//   inherit this session's environment. JOC_URL, when set, goes along as settings `env`, so the
//   new session reports to the same server. JOC_TOKEN never does: a command line is visible to
//   every process on the machine. The new session reads `/joc-login`'s credentials file instead.
// - A prompt that is a slash command (`/code-review 7`) runs as one.

/** Where this session reports, when the environment says so rather than `/joc-login`'s file. */
export interface LaunchEnv {
  url?: string;
}

/** The command that starts the session: named if the launch has a name, prompted if it has one. */
export function launchArgv(launch: { name?: string; prompt?: string }, env: LaunchEnv): string[] {
  const forwarded = {
    ...(env.url ? { JOC_URL: env.url } : {}),
  };
  return [
    'claude',
    '--bg',
    ...(Object.keys(forwarded).length ? ['--settings', JSON.stringify({ env: forwarded })] : []),
    ...(launch.name ? ['--name', launch.name] : []),
    ...(launch.prompt ? ['--', launch.prompt] : []),
  ];
}

/** The short id `claude --bg` printed for the session it started. */
export function backgroundId(stdout: string): string | undefined {
  return /backgrounded\s*·\s*([0-9a-f]{6,})/i.exec(stdout)?.[1]?.toLowerCase();
}

/** The full session id of the background session `claude agents --json` lists under `shortId`. */
export function sessionIdFor(agentsJson: string, shortId: string): string | undefined {
  try {
    const agents: unknown = JSON.parse(agentsJson);
    if (!Array.isArray(agents)) return undefined;
    for (const agent of agents) {
      const { id, sessionId } = (agent ?? {}) as { id?: unknown; sessionId?: unknown };
      if (id === shortId && typeof sessionId === 'string') return sessionId;
    }
  } catch {
    // Not the JSON this version of Claude Code prints: the id stays unknown.
  }
  return undefined;
}

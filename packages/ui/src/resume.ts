/** The command that resumes a session from its folder: `cd '<path>' && claude --resume <id>`. */
export function resumeCommand(sessionId: string, path?: string): string {
  const resume = `claude --resume ${sessionId}`;
  if (!path) return resume;
  // Single quotes keep spaces and $ literal; a quote in the path is closed, escaped and reopened.
  return `cd '${path.replaceAll("'", `'\\''`)}' && ${resume}`;
}

/** A session ID cut to 8 characters, like a short SHA. */
export function shortId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

/** A path shown as `…/` and its last three folders; a shorter path stays whole. */
export function shortPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 3) return path;
  return `…/${parts.slice(-3).join('/')}`;
}

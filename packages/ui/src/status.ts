// What a session's Status view says of its MCP servers. Pure, so it's tested in Node.

/** One of the session's MCP servers, connected or failing. */
export interface StatusMcpServer {
  name: string;
  state: 'connected' | 'failed';
  /** How many tools a connected server brings. */
  tools?: number;
}

/** "3 connected · 1 failing", for the MCP row. */
export function mcpSummary(servers: readonly StatusMcpServer[]): string {
  if (!servers.length) return 'None';
  const failed = servers.filter((s) => s.state === 'failed').length;
  const connected = servers.length - failed;
  return [connected ? `${connected} connected` : '', failed ? `${failed} failing` : '']
    .filter(Boolean)
    .join(' · ');
}

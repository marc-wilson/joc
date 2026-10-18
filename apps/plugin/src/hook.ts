// Entry point for every JOC hook: reads the hook's JSON from stdin and reports the session's
// state to the JOC server. It must never break or slow a Claude Code session, so every
// failure is swallowed and it always exits 0.
import { hostname } from 'node:os';
import type { SessionReport } from '@joc/protocol';
import { contextLeft } from './context.ts';
import { branchOf, repoOf } from './git.ts';
import { eventFields, type HookInput } from './report.ts';

const at = Date.now();
const serverUrl = (process.env.JOC_URL ?? 'http://localhost:3000').replace(/\/$/, '');

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const input = JSON.parse(await readStdin()) as HookInput;
  const fields = eventFields(input);
  if (!fields || !input.session_id) return;

  const ending = input.hook_event_name === 'SessionEnd';
  const report: SessionReport = {
    sessionId: input.session_id,
    at,
    repo: repoOf(input.cwd),
    branch: branchOf(input.cwd),
    machine: hostname().replace(/\.local$/, ''),
    contextLeft: ending ? undefined : contextLeft(input.transcript_path),
    ...fields,
  };

  await fetch(`${serverUrl}/api/reports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(report),
    // SessionEnd gets only a short budget before Claude Code exits.
    signal: AbortSignal.timeout(ending ? 1000 : 3000),
  });
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));

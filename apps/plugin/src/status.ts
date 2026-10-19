// hook.ts's side of the plugin's local problem log (problems.ts has the format).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { formatStatus, type PluginStatus, parseStatus, STATUS_PATH } from './problems.ts';

export const statusFile = () => join(homedir(), STATUS_PATH);

export function readStatus(file = statusFile()): PluginStatus {
  try {
    return parseStatus(readFileSync(file, 'utf8'));
  } catch {
    // Nothing recorded yet.
    return parseStatus(undefined);
  }
}

/**
 * Reads, changes and writes the log in one go, and only writes when something changed. Many
 * hooks run at once, so the read is as late as possible and the write replaces the file whole
 * (a rename): at worst a concurrent hook's change is lost, never the file.
 */
export function updateStatus(
  change: (status: PluginStatus) => PluginStatus,
  file = statusFile(),
): PluginStatus {
  const before = readStatus(file);
  const after = change(before);
  const text = formatStatus(after);
  if (text === formatStatus(before)) return after;
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, file);
  return after;
}

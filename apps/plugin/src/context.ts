import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

const TAIL_BYTES = 512 * 1024;

/**
 * Percent of the context window left, from the last assistant message's token usage in the
 * transcript. The transcript format isn't documented and may change, so any surprise gives
 * undefined rather than a wrong number.
 */
export function contextLeft(transcriptPath: string | undefined): number | undefined {
  if (!transcriptPath) return undefined;
  try {
    const fd = openSync(transcriptPath, 'r');
    try {
      const size = fstatSync(fd).size;
      const length = Math.min(size, TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      const lines = buffer.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const used = usedTokens(lines[i]);
        if (used !== undefined) {
          // The default window is 200k tokens; usage beyond that means a 1M-token model.
          const window = used > 200_000 ? 1_000_000 : 200_000;
          return Math.max(0, Math.min(100, Math.round(100 * (1 - used / window))));
        }
      }
      return undefined;
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

function usedTokens(line: string | undefined): number | undefined {
  if (!line?.includes('"usage"')) return undefined;
  try {
    const usage = JSON.parse(line)?.message?.usage;
    if (typeof usage?.input_tokens !== 'number') return undefined;
    return (
      usage.input_tokens +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0)
    );
  } catch {
    return undefined;
  }
}

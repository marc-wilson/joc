// Which plugin version machines should run, and which dashboard build this server serves. The
// plugin's version is the one in the repo's own plugin manifest, which the image ships with
// (see the Dockerfile), so a deploy and the plugin it expects never drift apart.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PluginVersion } from '@joc/protocol';
import { z } from 'zod';

/** The request header a plugin names its version in. */
export const PLUGIN_HEADER = 'x-joc-plugin';
/** The request header a plugin (0.7.1 on) names the version installed on its machine in. */
export const INSTALLED_HEADER = 'x-joc-plugin-installed';
/** The response header that tells a plugin which version it's behind. */
export const LATEST_HEADER = 'x-joc-plugin-latest';

const Manifest = z.object({ version: PluginVersion });

const MANIFEST = new URL('../../plugin/.claude-plugin/plugin.json', import.meta.url);

/** The plugin version this server expects. Throws when the manifest is missing or broken. */
export function readPluginVersion(path: URL | string = MANIFEST): PluginVersion {
  return Manifest.parse(JSON.parse(readFileSync(path, 'utf8'))).version;
}

/**
 * Names the dashboard build in `dist`: a hash of its index.html, which names every hashed asset,
 * so it changes exactly when the web code does and is the same on every replica of one image.
 */
export function webBuild(dist: string | undefined): string | undefined {
  if (!dist) return undefined;
  try {
    const html = readFileSync(join(dist, 'index.html'));
    return createHash('sha256').update(html).digest('hex').slice(0, 12);
  } catch {
    // No built dashboard there: nothing to name, and nothing for a tab to reload into.
    return undefined;
  }
}

/** `1.4.0-rc.1` → [1, 4, 0] and whether it's a prerelease. */
function parse(version: PluginVersion): { parts: number[]; pre: boolean } {
  const [core = '', pre] = version.split('-', 2);
  return { parts: core.split('.').map(Number), pre: pre !== undefined };
}

/** True when `version` is older than `latest`: semver order, a prerelease before its release. */
export function isBehind(version: PluginVersion, latest: PluginVersion): boolean {
  const a = parse(version);
  const b = parse(latest);
  for (let i = 0; i < 3; i++) {
    const diff = (a.parts[i] ?? 0) - (b.parts[i] ?? 0);
    if (diff !== 0) return diff < 0;
  }
  return a.pre && !b.pre;
}

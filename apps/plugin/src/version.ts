// The plugin's own version, which it names on every request so the server can tell when it's
// behind. Shared by hook.ts and register.ts, so nothing here touches Node or `$`.

/** The request header the plugin names its version in. */
export const PLUGIN_HEADER = 'x-joc-plugin';
/** Set on the server's answer when this plugin is behind; holds the version it should run. */
export const LATEST_HEADER = 'x-joc-plugin-latest';

/** The `version` of a plugin.json's text; undefined when it isn't one. */
export function manifestVersion(text: string): string | undefined {
  try {
    const manifest: unknown = JSON.parse(text);
    if (!manifest || typeof manifest !== 'object' || !('version' in manifest)) return undefined;
    return typeof manifest.version === 'string' ? manifest.version : undefined;
  } catch {
    // Not JSON: no version to name, and requests go without one.
    return undefined;
  }
}

/** The header naming `version`, or none when it's unknown. */
export const versionHeader = (version: string | undefined): { [PLUGIN_HEADER]?: string } =>
  version ? { [PLUGIN_HEADER]: version } : {};

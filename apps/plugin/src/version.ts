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

/**
 * The request header the hooks name the version installed on this machine in. It can differ from
 * the running one: a session keeps the copy it loaded until it reloads plugins.
 */
export const INSTALLED_HEADER = 'x-joc-plugin-installed';

/**
 * Where an installed copy of the plugin keeps Claude Code's list of installed plugins, and the
 * plugin's key in it, from the copy's folder: `<config>/plugins/cache/<marketplace>/<plugin>/
 * <version>`. Undefined for a copy run from elsewhere (a checkout, `--plugin-dir`), which isn't
 * installed.
 */
export function installedList(root: string): { file: string; key: string } | undefined {
  const match = root.replace(/\/+$/, '').match(/^(.*)\/plugins\/cache\/([^/]+)\/([^/]+)\/[^/]+$/);
  if (!match) return undefined;
  const [, config, marketplace, plugin] = match;
  return { file: `${config}/plugins/installed_plugins.json`, key: `${plugin}@${marketplace}` };
}

/**
 * The version installed_plugins.json's text lists for `key`: the user-wide install when there is
 * one, else the first listed. Undefined when it lists none, or isn't what Claude Code writes.
 */
export function installedVersion(text: string, key: string): string | undefined {
  let list: unknown;
  try {
    list = JSON.parse(text);
  } catch {
    // Not JSON: nothing installed to name.
    return undefined;
  }
  const entries = field(field(list, 'plugins'), key);
  if (!Array.isArray(entries)) return undefined;
  const versions = entries.flatMap((entry: unknown) => {
    const version = field(entry, 'version');
    return typeof version === 'string' ? [{ version, user: field(entry, 'scope') === 'user' }] : [];
  });
  return (versions.find((v) => v.user) ?? versions[0])?.version;
}

/** A JSON object's own field, or undefined. */
function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
}

/** The header naming `version`, or none when it's unknown. */
export const versionHeader = (version: string | undefined): { [PLUGIN_HEADER]?: string } =>
  version ? { [PLUGIN_HEADER]: version } : {};

/** The header naming the installed `version`, or none when it's unknown. */
export const installedHeader = (version: string | undefined): { [INSTALLED_HEADER]?: string } =>
  version ? { [INSTALLED_HEADER]: version } : {};

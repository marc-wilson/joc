import { Device, ServerVersion } from '@joc/protocol';
import { Banner, Button, Code, CopyCommand } from '@joc/ui';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { apiFetch } from './auth.ts';
import { behindTitle, UPDATE_COMMAND } from './version.ts';

// Version skew, both ways: a machine whose plugin is behind what the server expects, and this tab
// running dashboard code from before a deploy.

/** How often an open tab asks; also on coming back to the tab. */
const CHECK_MS = 5 * 60_000;
const DISMISSED_KEY = 'joc.plugin-banner.dismissed';

const Devices = z.array(Device);

interface Versions {
  /** The plugin version the server expects. */
  plugin?: string;
  /** The person's machines whose plugin is behind it. */
  behind: Device[];
  /** The server now serves a newer dashboard than this tab runs. */
  updated: boolean;
}

async function fetchVersion(): Promise<ServerVersion | undefined> {
  // Unreachable or refused: nothing to compare until the next check.
  const res = await apiFetch('/api/version').catch(() => undefined);
  const parsed = ServerVersion.safeParse(await res?.json().catch(() => undefined));
  return parsed.success ? parsed.data : undefined;
}

async function fetchDevices(): Promise<Device[] | undefined> {
  // Unreachable: the last list stands until the next check.
  const res = await apiFetch('/api/devices').catch(() => undefined);
  const parsed = Devices.safeParse(await res?.json().catch(() => undefined));
  return parsed.success ? parsed.data : undefined;
}

/** The build this tab loaded with: the first the server named. */
let loadedBuild: string | undefined;

/** Checks now, every few minutes, and whenever the tab comes back into view. */
function useVersions(): Versions {
  const [versions, setVersions] = useState<Versions>({ behind: [], updated: false });

  useEffect(() => {
    let live = true;
    async function check() {
      const [server, devices] = await Promise.all([fetchVersion(), fetchDevices()]);
      if (!live || !server) return;
      loadedBuild ??= server.build;
      setVersions((before) => ({
        plugin: server.plugin,
        behind: devices ? devices.filter((d) => d.outdated) : before.behind,
        // Once shown, it stays: a rolling deploy can answer from either build for a while.
        updated: before.updated || (!!server.build && server.build !== loadedBuild),
      }));
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    void check();
    const timer = setInterval(() => void check(), CHECK_MS);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return versions;
}

/** The plugin version whose banner the person dismissed, if any. */
function dismissedVersion(): string | undefined {
  try {
    return localStorage.getItem(DISMISSED_KEY) ?? undefined;
  } catch {
    // Storage blocked (private window, site data off): the banner shows again, nothing more.
    return undefined;
  }
}

function dismissVersion(version: string) {
  try {
    localStorage.setItem(DISMISSED_KEY, version);
  } catch {
    // Storage blocked: dismissed for this page only.
  }
}

/** App-wide notices under the nav bar: a plugin to update, or a newer dashboard to reload into. */
export function Updates() {
  const { plugin, behind, updated } = useVersions();
  const [dismissed, setDismissed] = useState(dismissedVersion);
  const [reloadHidden, setReloadHidden] = useState(false);

  return (
    <>
      {updated && !reloadHidden ? (
        <Banner
          title="JOC was updated"
          actions={
            <Button variant="secondary" size="sm" onClick={() => location.reload()}>
              Reload
            </Button>
          }
          onDismiss={() => setReloadHidden(true)}
        >
          This page still runs the previous version. Reload to get the new one.
        </Banner>
      ) : null}
      {plugin && behind.length > 0 && dismissed !== plugin ? (
        <Banner
          title={behindTitle(behind, plugin)}
          icon="terminal"
          onDismiss={() => {
            dismissVersion(plugin);
            setDismissed(plugin);
          }}
        >
          <span>
            Some features won't work there until it's updated. In a terminal on that machine, run:
          </span>
          <CopyCommand command={UPDATE_COMMAND} />
          <span>
            Then run <Code>/reload-plugins</Code> in its Claude Code sessions. From then on,{' '}
            <Code>/joc-update</Code> does both.
          </span>
        </Banner>
      ) : null}
    </>
  );
}

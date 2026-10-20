import { Device, ServerVersion, type StaleSession } from '@joc/protocol';
import { Banner, Button, Code, CopyCommand } from '@joc/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { apiFetch } from './auth.ts';
import { updatePrefs, usePrefs } from './prefs.ts';
import { StaleSessions, useReload } from './StaleSessions.tsx';
import {
  behindTitle,
  RELOAD_COMMAND,
  reloadable,
  staleDismissed,
  staleKey,
  staleTitle,
  UPDATE_COMMAND,
} from './version.ts';

// Version skew, both ways: a machine whose plugin is behind what the server expects (or sessions
// still running an old copy of it), and this tab running dashboard code from before a deploy.

/** How often an open tab asks; also on coming back to the tab. */
const CHECK_MS = 5 * 60_000;
const RELOAD_DISMISSED_KEY = 'joc.reload-banner.dismissed';
/** After reloads are sent: long enough for each session's next sync (every 30s) to report. */
const AFTER_RELOAD_MS = 40_000;

const Devices = z.array(Device);

interface Versions {
  /** The plugin version the server expects. */
  plugin?: string;
  /** The person's machines whose plugin is behind it. */
  behind: Device[];
  /** Live sessions on up-to-date machines that still run an old copy. */
  stale: StaleSession[];
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

/**
 * Checks now, every few minutes, and whenever the tab comes back into view; `checkSoon` checks
 * once more a little later, after reloads were sent.
 */
function useVersions(): Versions & { checkSoon: () => void } {
  const [versions, setVersions] = useState<Versions>({ behind: [], stale: [], updated: false });
  const checkNow = useRef<() => void>(() => {});

  useEffect(() => {
    let live = true;
    async function check() {
      const [server, devices] = await Promise.all([fetchVersion(), fetchDevices()]);
      if (!live || !server) return;
      loadedBuild ??= server.build;
      setVersions((before) => ({
        plugin: server.plugin,
        behind: devices ? devices.filter((d) => d.outdated) : before.behind,
        stale: devices ? reloadable(devices) : before.stale,
        // Once shown, it stays: a rolling deploy can answer from either build for a while.
        updated: before.updated || (!!server.build && server.build !== loadedBuild),
      }));
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    void check();
    checkNow.current = () => void check();
    const timer = setInterval(() => void check(), CHECK_MS);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const checkSoon = useCallback(() => {
    setTimeout(() => checkNow.current(), AFTER_RELOAD_MS);
  }, []);
  return { ...versions, checkSoon };
}

/** What the person dismissed under `key`, if anything. */
function dismissedUnder(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    // Storage blocked (private window, site data off): the banner shows again, nothing more.
    return undefined;
  }
}

function dismissUnder(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage blocked: dismissed for this page only.
  }
}

/** App-wide notices under the nav bar: a plugin to update, or a newer dashboard to reload into. */
export function Updates() {
  const { plugin, behind, stale, updated, checkSoon } = useVersions();
  // The plugin version whose banner the person dismissed, if any.
  const dismissed = usePrefs().dismissedPluginBanner;
  const [staleHidden, setStaleHidden] = useState(() => dismissedUnder(RELOAD_DISMISSED_KEY));
  const [reloadHidden, setReloadHidden] = useState(false);
  const reload = useReload(checkSoon);

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
          onDismiss={() => updatePrefs({ dismissedPluginBanner: plugin })}
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
      {plugin && stale.length > 0 && !staleDismissed(stale, staleHidden) ? (
        <Banner
          title={staleTitle(stale)}
          icon="terminal"
          actions={
            <Button
              variant="secondary"
              size="sm"
              loading={reload.busy}
              disabled={stale.every((s) => reload.sent.has(s.id))}
              onClick={() => void reload.send(stale.map((s) => s.id))}
            >
              {stale.every((s) => reload.sent.has(s.id))
                ? 'Reload sent'
                : stale.length === 1
                  ? 'Reload it'
                  : 'Reload them'}
            </Button>
          }
          onDismiss={() => {
            const key = staleKey(stale);
            dismissUnder(RELOAD_DISMISSED_KEY, key);
            setStaleHidden(key);
          }}
        >
          <span>
            JOC plugin {plugin} is installed, but {stale.length === 1 ? 'this session' : 'these'}{' '}
            loaded an older copy. Run <Code>{RELOAD_COMMAND}</Code> in{' '}
            {stale.length === 1 ? 'it' : 'each'}, or reload from here.
          </span>
          <StaleSessions sessions={stale} />
          {reload.failed ? <span>Couldn't send the reload. Try again.</span> : null}
        </Banner>
      ) : null}
    </>
  );
}

import { Device, ServerVersion, type StaleSession } from '@joc/protocol';
import { Banner, BannerSessions, Button, TextLink } from '@joc/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { apiFetch } from './auth.ts';
import { updatePrefs, usePrefs } from './prefs.ts';
import { useReload } from './StaleSessions.tsx';
import {
  behindTitle,
  RELOAD_COMMAND,
  reloadable,
  sessionHref,
  staleDismissed,
  staleKey,
  staleName,
  staleTitle,
  UPDATE_COMMAND,
  WHATS_NEW_URL,
} from './version.ts';

// Version skew, both ways: a machine whose plugin is behind what the server expects (or sessions
// still running an old copy of it), and this tab running dashboard code from before a deploy.

/** How often an open tab asks; also on coming back to the tab. */
const CHECK_MS = 5 * 60_000;
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

/** App-wide notices under the nav bar: a plugin to update, or a newer dashboard to reload into. */
export function Updates() {
  const { plugin, behind, stale, updated, checkSoon } = useVersions();
  // The plugin version, and the stale sessions, whose banners the person dismissed, if any.
  const { dismissedPluginBanner: dismissed, dismissedReloadBanner: staleHidden } = usePrefs();
  const [reloadHidden, setReloadHidden] = useState(false);
  const reload = useReload(checkSoon);

  const allSent = stale.every((s) => reload.sent.has(s.id));

  return (
    <>
      {updated && !reloadHidden ? (
        <Banner
          title="JOC was updated. This page still runs the previous version."
          icon="update"
          actions={
            <Button variant="secondary" size="sm" onClick={() => location.reload()}>
              Reload
            </Button>
          }
          onDismiss={() => setReloadHidden(true)}
        />
      ) : null}
      {plugin && behind.length > 0 && dismissed !== plugin ? (
        <Banner
          // Once it's updated, its sessions show in the banner below to reload.
          title={`${behindTitle(behind, plugin)}. Update it there with`}
          icon="update"
          command={UPDATE_COMMAND}
          actions={<TextLink href={WHATS_NEW_URL}>What's new</TextLink>}
          onDismiss={() => updatePrefs({ dismissedPluginBanner: plugin })}
        />
      ) : null}
      {plugin && stale.length > 0 && !staleDismissed(stale, staleHidden) ? (
        <Banner
          title={staleTitle(stale)}
          icon="plug"
          actions={
            <Button
              variant="secondary"
              size="sm"
              title={`Sends ${RELOAD_COMMAND} to ${stale.length === 1 ? 'it' : 'each'}, which loads JOC plugin ${plugin}`}
              loading={reload.busy}
              disabled={allSent}
              onClick={() => void reload.send(stale.map((s) => s.id))}
            >
              {allSent ? 'Reload sent' : stale.length === 1 ? 'Reload it' : 'Reload them'}
            </Button>
          }
          onDismiss={() => updatePrefs({ dismissedReloadBanner: staleKey(stale) })}
        >
          <BannerSessions
            sessions={stale.map((s) => ({
              id: s.id,
              title: staleName(s),
              state: s.state,
              href: sessionHref(s.id),
            }))}
          />
          {reload.failed ? <span>Couldn't send the reload. Try again.</span> : null}
        </Banner>
      ) : null}
    </>
  );
}

import type { Theme } from '@joc/protocol';
import { useEffect } from 'react';
import { currentPrefs, onPrefsChange } from './prefs.ts';
import { resolveTheme, THEME_KEY } from './theme-choice.ts';

// The dashboard's colours: `data-theme` on the root element, from the person's Theme pref. The
// choice is mirrored in this browser's storage so index.html can set it before the page draws;
// the server's pref then wins once it's read.

/** As index.html asks it: dark unless the system says light. */
const LIGHT = '(prefers-color-scheme: light)';

const systemDark = () => !window.matchMedia?.(LIGHT).matches;

function apply(choice: Theme) {
  const theme = resolveTheme(choice, systemDark());
  // Set only on a change, so nothing redraws for nothing.
  if (document.documentElement.dataset.theme !== theme) {
    document.documentElement.dataset.theme = theme;
  }
  try {
    if (localStorage.getItem(THEME_KEY) !== choice) localStorage.setItem(THEME_KEY, choice);
  } catch {
    // Storage blocked: the server's pref still applies once it's read.
  }
}

/**
 * Keeps the root element's theme in step with the Theme pref while mounted, and with the
 * system's appearance while the pref is System.
 */
export function useTheme() {
  useEffect(() => {
    const sync = () => apply(currentPrefs().theme);
    sync();
    const offPrefs = onPrefsChange(sync);
    const media = window.matchMedia?.(LIGHT);
    media?.addEventListener('change', sync);
    return () => {
      offPrefs();
      media?.removeEventListener('change', sync);
    };
  }, []);
}

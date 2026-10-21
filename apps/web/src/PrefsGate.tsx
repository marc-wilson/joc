import type { ReactNode } from 'react';
import { usePrefsLoaded, usePrefsSync } from './prefs.ts';
import { useTheme } from './theme.ts';

/**
 * Keeps the prefs in step with other tabs, and the page's theme with them. Mounted with the
 * page, so both hear its snapshot.
 */
function PrefsSync() {
  usePrefsSync();
  useTheme();
  return null;
}

/**
 * Holds the page until the person's prefs are read (a moment, or the defaults after a short
 * wait), so pinned sessions and folds don't move into place after it shows.
 */
export function PrefsGate({ children }: { children: ReactNode }) {
  if (!usePrefsLoaded()) return null;
  return (
    <>
      <PrefsSync />
      {children}
    </>
  );
}

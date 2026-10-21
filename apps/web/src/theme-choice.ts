import type { Theme } from '@joc/protocol';

/** The storage key index.html reads before anything else loads. Keep the two in step. */
export const THEME_KEY = 'joc.theme';

/** The colours a choice draws in, given whether the system is dark. */
export const resolveTheme = (choice: Theme, systemDark: boolean): 'light' | 'dark' =>
  choice === 'system' ? (systemDark ? 'dark' : 'light') : choice;

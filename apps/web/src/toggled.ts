import { MAX_PREF_ITEMS } from '@joc/protocol';

/** `list` with `id` in it or out of it, order otherwise kept, newest last, within the prefs cap. */
export function toggled(list: string[], id: string, on: boolean): string[] {
  const rest = list.filter((x) => x !== id);
  return (on ? [...rest, id] : rest).slice(-MAX_PREF_ITEMS);
}

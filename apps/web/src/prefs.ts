import { useState } from 'react';

// Per-viewer conveniences in this browser. The page works the same when storage is unavailable.

export function stored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function store(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

/** State remembered under `key`, read once when the component mounts. */
export function usePref<T>(key: string, fallback: T): [T, (next: T) => void] {
  const [value, setValue] = useState(() => stored(key, fallback));
  return [
    value,
    (next: T) => {
      setValue(next);
      store(key, next);
    },
  ];
}

/** `list` with `id` in it or out of it; order otherwise kept. */
export function toggled(list: string[], id: string, on: boolean): string[] {
  const rest = list.filter((x) => x !== id);
  return on ? [...rest, id] : rest;
}

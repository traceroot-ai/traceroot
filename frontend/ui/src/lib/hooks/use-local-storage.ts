"use client";

import { useCallback, useEffect, useState } from "react";

// localStorage lives on `window` in the browser and is undefined during SSR.
// Accessing it can also throw in some privacy modes, so the access itself is guarded.
function getLocalStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Read and JSON-parse a value from localStorage, falling back to `fallback` on
 * any failure: SSR (no window), missing key, malformed JSON, or a throwing read.
 */
export function readStored<T>(key: string, fallback: T): T {
  const storage = getLocalStorage();
  if (!storage) return fallback;
  try {
    const raw = storage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * JSON-serialize and persist a value to localStorage. Persistence is best-effort:
 * SSR, quota-exceeded, private mode, or disabled storage are swallowed silently.
 */
export function writeStored<T>(key: string, value: T): void {
  const storage = getLocalStorage();
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Best-effort — keep the in-memory value if persistence fails.
  }
}

/**
 * SSR-safe, localStorage-backed state. Mirrors the `useState` API:
 *
 *   const [live, setLive] = useLocalStorage(`traceroot:traces:live:v1:${projectId}`, false);
 *
 * - Hydration: the first render always returns `defaultValue` (the server has no
 *   localStorage), and the stored value is adopted in an effect after mount, so the
 *   server and first client render are identical and React logs no hydration warning.
 *   On a hard load where the saved value differs from the default there is a brief
 *   flash at the default before the stored value applies — expected and acceptable.
 * - Storage unavailable (private mode / quota / disabled): reads and writes are
 *   guarded by `readStored` / `writeStored`. The value is real React state, so the
 *   setter always updates the UI in-session even when persistence silently fails.
 * - Cross-tab sync: a `storage` event (fired only in *other* tabs) re-reads the value.
 */
export function useLocalStorage<T>(
  key: string,
  defaultValue: T,
): [T, (value: T | ((prev: T) => T)) => void] {
  // Start from the default so the first client render matches the server render.
  const [value, setValue] = useState<T>(defaultValue);

  // Adopt the persisted value after mount, and re-read if the key changes.
  useEffect(() => {
    setValue(readStored(key, defaultValue));
    // defaultValue is intentionally excluded: it is the initial fallback, not a
    // trigger to re-read storage on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Reflect writes made by other tabs. `e.key` is null when storage is cleared.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === key || e.key === null) {
        setValue(readStored(key, defaultValue));
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
        writeStored(key, resolved);
        return resolved;
      });
    },
    [key],
  );

  return [value, set];
}

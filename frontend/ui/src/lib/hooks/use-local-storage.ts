"use client";

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

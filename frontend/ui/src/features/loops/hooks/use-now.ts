"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * The current time, refreshed every `everyMs`, so relative times ("in 3h", "Due now") keep moving.
 * Null on the server and while hydrating: the clock is read after mount, so the first client
 * render matches the server's HTML.
 */
export function useNow(everyMs = 30_000): Date | null {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

const subscribeToNothing = () => () => {};
const readBrowserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/**
 * The browser's IANA zone; null on the server and while hydrating, so the first
 * client render matches the server's HTML.
 */
export function useBrowserTimezone(): string | null {
  return useSyncExternalStore(subscribeToNothing, readBrowserZone, () => null);
}

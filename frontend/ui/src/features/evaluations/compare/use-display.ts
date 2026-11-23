"use client";

import * as React from "react";
import { useLocalStorage } from "@/lib/hooks/use-local-storage";
import { DEFAULT_DISPLAY, displayStorageKey, normalizeDisplay, type DisplayPrefs } from "./display";

/**
 * The viewer's table layout for this project. Storage that is missing, unreadable or
 * refused reads as the default, and a change still applies for the session when it can't
 * be saved (`useLocalStorage` guards every access).
 */
export function useDisplay(projectId: string): [DisplayPrefs, (next: DisplayPrefs) => void] {
  const [stored, setStored] = useLocalStorage<unknown>(
    displayStorageKey(projectId),
    DEFAULT_DISPLAY,
  );
  const display = React.useMemo(() => normalizeDisplay(stored), [stored]);
  return [display, setStored];
}

/**
 * Scroll a list's own scroll container back to the top whenever `key` changes.
 *
 * List pages render their rows inside an `overflow-auto` div, and pagination swaps
 * the rows without remounting it, so a new page would otherwise open at the old
 * page's scroll offset. Pass the inputs of the list query as the key (page, limit,
 * search, filters, date window): any change to it means a different set of rows.
 */
import { useEffect, useRef, type RefObject } from "react";

export function useScrollToTopOnChange(ref: RefObject<HTMLElement | null>, key: string): void {
  // Compare against the last key seen rather than a "first render" flag: StrictMode
  // runs mount effects twice, which would make a flag read the second run as a change.
  // Starting from the mount key also leaves the initial load and any restored scroll
  // position alone.
  const lastKey = useRef(key);

  useEffect(() => {
    if (lastKey.current === key) return;
    lastKey.current = key;
    if (ref.current) ref.current.scrollTop = 0;
  }, [ref, key]);
}

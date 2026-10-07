/**
 * Lets a detail page link back to the list it was opened from, on the same page and
 * filters. List pages keep that state in their URL query, so browser Back already
 * restores it; a breadcrumb or "Back" link is a plain href, though, and would drop
 * it. The list records its query here and the detail page's link reuses it.
 *
 * Per tab (sessionStorage) and per list key (e.g. one per project). Sidebar links
 * stay bare on purpose: entering a section from the sidebar starts from page 1.
 */
import { useEffect, useState } from "react";

const storageKey = (listKey: string) => `list-return:${listKey}`;

/** Called by a list page with its current URL query (`searchParams.toString()`). */
export function useRememberListQuery(listKey: string, query: string) {
  useEffect(() => {
    try {
      if (query) sessionStorage.setItem(storageKey(listKey), query);
      else sessionStorage.removeItem(storageKey(listKey));
    } catch {
      // Storage blocked (private mode, sandboxed frame): the link falls back to the bare list.
    }
  }, [listKey, query]);
}

/** `listPath` plus the query the list was last showing in this tab, if any. */
export function useListReturnHref(listKey: string, listPath: string): string {
  const [href, setHref] = useState(listPath);
  // Read after mount so the server render and first client render agree on the href.
  useEffect(() => {
    let query: string | null = null;
    try {
      query = sessionStorage.getItem(storageKey(listKey));
    } catch {
      // Same fallback as above.
    }
    setHref(query ? `${listPath}?${query}` : listPath);
  }, [listKey, listPath]);
  return href;
}

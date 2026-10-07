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

// The date window as `buildUrlWithFilters` writes it.
const DATE_WINDOW_PARAMS = ["date_filter", "start", "end"] as const;

const splitHref = (href: string): [string, string] => {
  const i = href.indexOf("?");
  return i === -1 ? [href, ""] : [href.slice(0, i), href.slice(i + 1)];
};

/** `query` with its date window replaced by the one `datedHref` carries. */
export function withDateWindow(query: string, datedHref: string): string {
  const params = new URLSearchParams(query);
  const dated = new URLSearchParams(splitHref(datedHref)[1]);
  for (const key of DATE_WINDOW_PARAMS) {
    const value = dated.get(key);
    if (value === null) params.delete(key);
    else params.set(key, value);
  }
  return params.toString();
}

/**
 * Back link for a detail page that shares the list's date window (the date filter
 * follows the user between list and detail). Starts from the list query recorded in
 * this tab (`rememberedHref`, from `useListReturnHref`) and overlays the detail
 * page's current window (`datedHref`), so a range changed on the detail page still
 * carries back. When that window differs from the one the list recorded, the list's
 * page is dropped: it may not exist in the new result set. With no recorded query,
 * this is just `datedHref`.
 */
export function listReturnHrefWithDateWindow(rememberedHref: string, datedHref: string): string {
  const [path, remembered] = splitHref(rememberedHref);
  if (!remembered) return datedHref;
  const before = new URLSearchParams(remembered);
  const after = new URLSearchParams(withDateWindow(remembered, datedHref));
  if (DATE_WINDOW_PARAMS.some((key) => before.get(key) !== after.get(key))) {
    after.delete("page_index");
  }
  const qs = after.toString();
  return qs ? `${path}?${qs}` : path;
}

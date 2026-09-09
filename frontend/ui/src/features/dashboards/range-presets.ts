import {
  clampDateFilter,
  DATE_FILTER_OPTIONS,
  DEFAULT_DATE_FILTER,
  findDateFilterOption,
  type DateFilterOption,
} from "@/lib/date-filter";
import { readStoredDateFilter, type StoredDateFilter } from "@/lib/date-filter-storage";
import type { TimeRange } from "./types";

// The widget builder's preview-window presets ARE the shared trace-list
// date-filter options (minus "custom", which needs the full range-picker UI
// the preview doesn't have). This module used to hold its own hand-rolled
// 24h/7d/30d list with a 7-day default, which silently diverged from the
// 24-hour default the trace list and dashboard page share — it is now a thin
// adapter over lib/date-filter.ts so there is exactly one source of truth for
// presets and default across all three surfaces.
export const RANGE_PRESETS = DATE_FILTER_OPTIONS.filter((o) => o.durationMinutes !== null);

// The same default the trace list and dashboard page resolve to (24 hours).
export const DEFAULT_RANGE_ID = DEFAULT_DATE_FILTER.id;

/**
 * The range the rest of the site is currently using for this project, as one
 * of this module's presets. It reads the per-project selection the shared
 * date-filter picker persists (readStoredDateFilter — the exact slot the
 * trace list, dashboards, and detectors pages write through), so a surface
 * with no picker of its own charts the window the user actually chose.
 *
 * The shared default answers for everything the stored slot can't say: no
 * project to key by, nothing stored, storage unavailable (SSR, privacy
 * modes — readStoredDateFilter swallows those), an id no preset here knows,
 * and the custom option, whose explicit start/end these preset-only surfaces
 * have no picker to represent.
 *
 * The result is then clamped to the plan's retention window, the same way the
 * picker's own pages clamp theirs: a 90d selection left in storage by a
 * workspace that has since downgraded must not be queried or labeled. Pass
 * `retentionDays` as undefined while the plan is still resolving — clamping
 * against an unknown plan would narrow every window on a hard reload.
 */
/**
 * The date filter the current URL pins, if it carries one. A shared link's
 * range wins over the stored selection on the page it targets — the same
 * precedence useUrlDateFilter applies — and it is deliberately never written
 * to storage, so a surface with no picker of its own can only see it here.
 * Without this read, a page opened on ?date_filter=7d charts seven days while
 * the cards beside it chart whatever was stored, naming two different windows
 * for the same moment.
 *
 * Browser-only and non-reactive, exactly like readStoredDateFilter: callers
 * snapshot their range once when a card is built, so there is nothing to
 * subscribe to, and on the server there is no URL to read.
 */
function readUrlDateFilterId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const search = window.location?.search;
    if (!search) return null;
    return new URLSearchParams(search).get("date_filter");
  } catch {
    // Same swallow as readStoredDateFilter: a hostile or absent location must
    // not take down a card that only wanted to name its window.
    return null;
  }
}

export function resolveSiteRange(
  projectId: string | null | undefined,
  retentionDays?: number | null,
): DateFilterOption {
  // URL first, storage second — the precedence the picker itself uses, so a
  // link that pins a window is the window every surface on that page reports.
  const pinnedId = readUrlDateFilterId();
  const stored = projectId ? readStoredDateFilter(projectId) : null;
  const selectedId = pinnedId ?? stored?.id ?? null;
  const selected =
    selectedId === null
      ? DEFAULT_DATE_FILTER
      : (RANGE_PRESETS.find((option) => option.id === selectedId) ?? DEFAULT_DATE_FILTER);
  return clampDateFilter(selected, retentionDays);
}

export function makeRange(optionId: string): TimeRange {
  // findDateFilterOption falls back to the default option for unknown ids;
  // the ?? covers the custom option's null duration, which callers never pass
  // (RANGE_PRESETS filters custom out).
  const minutes =
    findDateFilterOption(optionId).durationMinutes ?? DEFAULT_DATE_FILTER.durationMinutes!;
  // Derive start from a single clock read so the range spans exactly the
  // preset's duration; a second read would skew it by the ms elapsed between.
  const end = new Date();
  return {
    start: new Date(end.getTime() - minutes * 60_000),
    end,
  };
}

/**
 * The window the agent should answer dashboard reads for, as the messages
 * request carries it: the site's selected preset for this project, or — for
 * the picker's custom option, which no preset can name — its explicit bounds.
 */
export type SiteWindow = { range: string } | { start_time: string; end_time: string };

/** The custom option's bounds the URL pins (`?date_filter=custom&start=…&end=…`), if any. */
function readUrlCustomBounds(): { start: string; end: string } | null {
  if (typeof window === "undefined") return null;
  try {
    const params = new URLSearchParams(window.location?.search ?? "");
    const start = params.get("start");
    const end = params.get("end");
    return start && end ? { start, end } : null;
  } catch {
    return null;
  }
}

function expiredBounds(bounds: SiteWindow, retentionDays: number | null | undefined): boolean {
  if (retentionDays == null || !("end_time" in bounds)) return false;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60_000;
  return Date.parse(bounds.end_time) <= cutoff;
}

function validBounds(pair: { start?: string; end?: string } | null): SiteWindow | null {
  if (!pair?.start || !pair.end) return null;
  const start = Date.parse(pair.start);
  const end = Date.parse(pair.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  // Normalized: the picker writes toISOString, but a hand-edited URL can carry
  // any form Date.parse accepts, and the server takes only ISO instants.
  return { start_time: new Date(start).toISOString(), end_time: new Date(end).toISOString() };
}

/**
 * The window the rest of the site is using for this project, in the shape
 * the agent's messages request takes. The same precedence as
 * resolveSiteRange — the URL-pinned filter, then the stored pick, then the
 * default — with one difference: where that helper collapses the custom
 * option to the default because a preset-only chart cannot draw it, a query
 * can be answered for any bounds, so a custom selection with a valid, ordered
 * pair (from the URL when the page pins one, else from storage) is sent as
 * explicit bounds. A preset is clamped to the plan's retention here, like
 * the picker's own pages clamp theirs; custom bounds are sent as they are and
 * the server clamps them, echoing the window it answered for — unless they
 * end before the retention cutoff, when the default stands in for them.
 */
export function resolveSiteWindow(
  projectId: string | null | undefined,
  retentionDays?: number | null,
): SiteWindow {
  const pinnedId = readUrlDateFilterId();
  const stored: StoredDateFilter | null = projectId ? readStoredDateFilter(projectId) : null;
  const selectedId = pinnedId ?? stored?.id ?? null;
  if (selectedId === "custom") {
    // The URL is the page's window when it pins one: a custom link with
    // unusable bounds is the default, never whatever the picker last stored.
    const custom =
      pinnedId === "custom"
        ? validBounds(readUrlCustomBounds())
        : stored?.id === "custom"
          ? validBounds(stored)
          : null;
    // Bounds wholly before the plan's retention would only earn a 422 from
    // the server; answer for the default instead. Bounds that still overlap
    // retention go as they are, and the server clamps the start.
    if (custom !== null && !expiredBounds(custom, retentionDays)) return custom;
  }
  return { range: resolveSiteRange(projectId, retentionDays).id };
}

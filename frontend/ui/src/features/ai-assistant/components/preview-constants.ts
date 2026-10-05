import { ROW_HEIGHT } from "@/features/dashboards/grid-constants";
import { DEFAULT_SIZE } from "@/features/dashboards/widget-placement";

/**
 * What the assistant panel's card previews share: the proportions they draw
 * a dashboard tile at, and the query discipline every card data query keeps.
 * Kept apart from the preview components because those load through
 * next/dynamic (they pull in the dashboards renderers, and with them
 * recharts), while the card that frames them sits in every page's layout.
 */

/**
 * The one number the real grid does not fix: its column width, which the app
 * measures from the container at render time. The previews scale a
 * representative rendering instead — an 88px column (a 1056px grid), which
 * against the real 56px row height keeps a 6x4 chart tile at ~2.35:1, the
 * shape the dashboard itself draws. Everything else derives from the grid's
 * constants.
 */
export const REFERENCE_COL_WIDTH = 88;

/**
 * The shape of one freshly placed chart tile at the reference proportions —
 * the frame the widget card's chart preview draws in, so the preview reads as
 * a dashboard tile that happens to live in the chat. Derived from the same
 * constants as the dashboard preview, never hardcoded, so a grid change
 * moves both.
 */
export const CHART_TILE_ASPECT = `${DEFAULT_SIZE.query.w * REFERENCE_COL_WIDTH} / ${DEFAULT_SIZE.query.h * ROW_HEIGHT}`;

/**
 * A card's query is a snapshot, not a live dashboard: its window is frozen at
 * first visibility, so the fetched result never goes stale — and it must not
 * refetch on its own. Every ever-visible card in a transcript keeps a mounted
 * query, so a single tab focus (or reconnect) would otherwise refire the
 * whole accumulated transcript against ClickHouse at once. Shared by every
 * card data query — the dashboard preview's tiles and the widget card's
 * chart.
 */
export const SNAPSHOT_QUERY_OPTIONS = {
  staleTime: Infinity,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
} as const;

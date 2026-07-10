import type { Span } from "@/types/api";
import { buildSpanTree, getSpanDuration, getSpanStartMs, getVisibleSpanRows } from "../utils";

export interface TimelineMetrics {
  startOffsetPx: number;
  widthPx: number;
  durationMs: number;
  isInProgress: boolean;
  isInstant: boolean;
}

export interface FlatTimelineItem {
  span: Span;
  metrics: TimelineMetrics;
}

/**
 * Flattens spans into the DFS-ordered visible-row list for virtualized
 * rendering, pre-computing pixel offsets and widths for the Gantt bars.
 *
 * Row derivation is shared with SpanTreeView: both panels consume the same
 * cached buildSpanTree rows and the same getVisibleSpanRows collapse filter,
 * so the scroll-synced, row-aligned panels cannot diverge in visible-span
 * order. This flattener only layers per-span pixel metrics on top. The parity
 * test in SpanTreeView.test.ts still guards the row-order invariant.
 */
export function flattenTreeWithMetrics(
  spans: Span[],
  collapsedIds: Set<string>,
  traceDurationMs: number,
  scaleWidth: number,
): FlatTimelineItem[] {
  if (!spans || spans.length === 0) return [];

  const rows = buildSpanTree(spans);
  const spanById = new Map(spans.map((s) => [s.span_id, s]));
  const visibleRows = getVisibleSpanRows(rows, spanById, collapsedIds);

  const traceStartMs = spans.reduce((min, s) => Math.min(min, getSpanStartMs(s)), Infinity);
  const safeTraceDuration = Math.max(1, traceDurationMs);

  return visibleRows.map(({ span }) => {
    const offsetMs = getSpanStartMs(span) - traceStartMs;
    const durationMs = getSpanDuration(span) ?? 0;
    const isInProgress = span.span_end_time === null;

    const startOffsetPx = (offsetMs / safeTraceDuration) * scaleWidth;
    const widthPx = (durationMs / safeTraceDuration) * scaleWidth;
    const isInstant = !isInProgress && (widthPx < 2 || durationMs / safeTraceDuration < 0.002);

    return {
      span,
      metrics: {
        startOffsetPx: Math.max(0, startOffsetPx),
        widthPx: Math.max(0, widthPx),
        durationMs,
        isInProgress,
        isInstant,
      },
    };
  });
}

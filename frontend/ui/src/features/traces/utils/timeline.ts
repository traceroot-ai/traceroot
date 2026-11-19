import type { Span } from "@/types/api";
import {
  buildChildrenMap,
  compareSpansForStableDisplay,
  getSpanDuration,
  parseTimestamp,
} from "../utils";

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
 * Flattens a flat array of spans into a DFS-ordered list for virtualized rendering,
 * pre-computing pixel offsets and widths for the Gantt bars.
 *
 * The visible-span ORDER produced here must stay identical to SpanTreeView's
 * `buildTreeRows`/`getVisibleSpanRows` — the timeline and tree panels are
 * scroll-synced row-for-row, so any divergence in which spans are emitted (or
 * their order) silently misaligns them. The collapse skip below mirrors the
 * tree's ancestor-collapse filter, and a parity test guards it in
 * SpanTreeView.test.ts.
 *
 * TODO: unify this visible-span derivation with SpanTreeView's
 * getVisibleSpanRows/buildTreeRows so the collapse logic lives in one place.
 * Deferred because this flattener also computes pixel metrics and works on raw
 * Span[] (not SpanTreeRow[]), so the merge is non-trivial. The parity test
 * protects the invariant until then.
 */
export function flattenTreeWithMetrics(
  spans: Span[],
  collapsedIds: Set<string>,
  traceDurationMs: number,
  scaleWidth: number,
): FlatTimelineItem[] {
  if (!spans || spans.length === 0) return [];

  // Cache parsed timestamps to avoid re-parsing during traversal
  const startTimes = new Map<string, number>();
  for (const span of spans) {
    startTimes.set(span.span_id, parseTimestamp(span.span_start_time));
  }

  const traceStartMs = spans.reduce(
    (min, s) => Math.min(min, startTimes.get(s.span_id)!),
    Infinity,
  );

  const childrenMap = buildChildrenMap(spans);
  const spanIds = new Set(spans.map((s) => s.span_id));

  // Stable sibling order (start → end → span_id) — must match SpanTreeView's
  // buildSpanTree so the scroll-synced timeline and tree panels stay row-aligned.
  for (const children of childrenMap.values()) {
    children.sort(compareSpansForStableDisplay);
  }

  // True roots + orphan spans (parent not yet arrived), same stable order.
  const trueRoots = childrenMap.get(null) ?? [];
  const orphans = spans.filter((s) => s.parent_span_id !== null && !spanIds.has(s.parent_span_id));
  const topLevel = [...trueRoots, ...orphans].sort(compareSpansForStableDisplay);

  const flatList: FlatTimelineItem[] = [];
  const safeTraceDuration = Math.max(1, traceDurationMs);

  // Iterative DFS — avoids stack overflow on deeply-nested traces (recursive
  // agents, deep ReAct loops). Children are pushed in reverse so the first
  // child is popped first, preserving chronological DFS order.
  const stack: Span[] = [];
  for (let i = topLevel.length - 1; i >= 0; i--) {
    stack.push(topLevel[i]);
  }

  while (stack.length > 0) {
    const span = stack.pop()!;

    const offsetMs = startTimes.get(span.span_id)! - traceStartMs;
    const durationMs = getSpanDuration(span) ?? 0;
    // A pending placeholder has no end time because we never received it, not
    // because it is still running — rendering it as in-progress would pulse a
    // "live" bar on a trace that finished (or died) long ago.
    const isInProgress = span.span_end_time === null && !span.pending;

    const startOffsetPx = (offsetMs / safeTraceDuration) * scaleWidth;
    const widthPx = (durationMs / safeTraceDuration) * scaleWidth;
    const isInstant = !isInProgress && (widthPx < 2 || durationMs / safeTraceDuration < 0.002);

    flatList.push({
      span,
      metrics: {
        startOffsetPx: Math.max(0, startOffsetPx),
        widthPx: Math.max(0, widthPx),
        durationMs,
        isInProgress,
        isInstant,
      },
    });

    if (!collapsedIds.has(span.span_id)) {
      const children = childrenMap.get(span.span_id) ?? [];
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push(children[i]);
      }
    }
  }

  return flatList;
}

import type { Span } from "@/types/api";
import { buildChildrenMap, getSpanDuration, parseTimestamp } from "../utils";

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

  for (const children of childrenMap.values()) {
    children.sort((a, b) => startTimes.get(a.span_id)! - startTimes.get(b.span_id)!);
  }

  // True roots + orphan spans (parent not yet arrived), sorted by time
  const trueRoots = childrenMap.get(null) ?? [];
  const orphans = spans.filter((s) => s.parent_span_id !== null && !spanIds.has(s.parent_span_id));
  const topLevel = [...trueRoots, ...orphans].sort(
    (a, b) => startTimes.get(a.span_id)! - startTimes.get(b.span_id)!,
  );

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
    const isInProgress = span.span_end_time === null;

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

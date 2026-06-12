/**
 * Trace feature utilities
 */
import { SpanKind, SpanStatus } from "@traceroot/core";
import type { Span, TraceDetail } from "@/types/api";
import type { SpanTreeRow } from "../types";
import { parseAsUTC } from "@/lib/utils";

export function parseTimestamp(ts: string): number {
  return parseAsUTC(ts.trim()).getTime();
}

export function compareSpansForStableDisplay(a: Span, b: Span): number {
  const startDelta = parseTimestamp(a.span_start_time) - parseTimestamp(b.span_start_time);
  if (startDelta !== 0) return startDelta;

  const aEnd = a.span_end_time ? parseTimestamp(a.span_end_time) : Number.POSITIVE_INFINITY;
  const bEnd = b.span_end_time ? parseTimestamp(b.span_end_time) : Number.POSITIVE_INFINITY;
  const endDelta = aEnd - bEnd;
  if (endDelta !== 0) return endDelta;

  return a.span_id.localeCompare(b.span_id);
}

function parseMetadata(metadata: string | null): Record<string, unknown> {
  if (!metadata) return {};
  try {
    return JSON.parse(metadata) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * For every span that carries traceroot.span.ids_path (ancestor IDs, root→parent)
 * and traceroot.span.path (root→current names) in its metadata, create lightweight
 * placeholder spans for any missing ancestors.
 *
 * Works for both live SSE streaming AND completed traces loaded from ClickHouse,
 * because both carry the same metadata JSON.
 */
export function enrichSpansWithPending(spans: Span[]): Span[] {
  const existingSpanIds = new Set(spans.map((s) => s.span_id));
  const pendingSpans = new Map<string, Span>();

  for (const span of spans) {
    if (span.pending) pendingSpans.set(span.span_id, span);
  }

  for (const span of spans) {
    if (!span.parent_span_id) continue;

    // Skeleton spans omit metadata (parseMetadata(null|undefined) → {}); live
    // SSE spans still carry it, so enrichment keeps working from live events.
    const meta = parseMetadata(span.metadata ?? null);
    const idsPath = meta["traceroot.span.ids_path"] as string[] | undefined;
    const namePath = meta["traceroot.span.path"] as string[] | undefined;

    if (!idsPath || !namePath || idsPath.length === 0) continue;
    const ancestorNames = namePath.slice(0, -1);
    if (idsPath.length !== ancestorNames.length) continue;

    for (let i = 0; i < idsPath.length; i++) {
      const spanId = idsPath[i];
      const spanName = ancestorNames[i];

      if (existingSpanIds.has(spanId) && !pendingSpans.has(spanId)) continue;

      if (pendingSpans.has(spanId)) {
        const existing = pendingSpans.get(spanId)!;
        const existStart = parseTimestamp(existing.span_start_time);
        const curStart = parseTimestamp(span.span_start_time);
        if (curStart < existStart) {
          pendingSpans.set(spanId, { ...existing, span_start_time: span.span_start_time });
        }
        continue;
      }

      const parentId = i > 0 ? idsPath[i - 1] : null;
      pendingSpans.set(spanId, {
        span_id: spanId,
        trace_id: span.trace_id,
        parent_span_id: parentId,
        name: spanName,
        span_kind: SpanKind.SPAN,
        span_start_time: span.span_start_time,
        span_end_time: null,
        status: SpanStatus.OK,
        status_message: null,
        model_name: null,
        cost: null,
        input_tokens: null,
        output_tokens: null,
        total_tokens: null,
        input: null,
        output: null,
        metadata: null,
        git_source_file: null,
        git_source_line: null,
        git_source_function: null,
        pending: true,
      });
    }
  }

  const nonPendingSpans = spans.filter((s) => !s.pending);
  const nonPendingIds = new Set(nonPendingSpans.map((s) => s.span_id));
  const newPending = [...pendingSpans.values()].filter((s) => !nonPendingIds.has(s.span_id));
  return [...nonPendingSpans, ...newPending];
}

// Layout constants for tree alignment
export const TREE_LAYOUT = {
  NESTING_INDENT: 22, // Space per nesting level
  ROW_HEIGHT: 28, // Height of each row (compact)
  ICON_BOX_SIZE: 18, // Size of icon box
  LEFT_PADDING: 8, // Left padding before first icon
} as const;

// Row overscan: how many rows @tanstack/react-virtual renders beyond the
// viewport on each side. Shared by both virtualized views (SpanTreeView +
// SpanTimelineView) so the scroll-synced, row-aligned panels buffer identically
// and never drift. A larger buffer means fewer blank-row flashes during fast /
// momentum scrolling, at a small extra-DOM cost — and rows here are fixed-height
// and cheap (~18 nodes each), so we keep a generous buffer. 26 rows ≈ 730px,
// past the point of visible flashing on a quick fling.
export const TREE_OVERSCAN_ROWS = 26;

/**
 * Calculate span duration in milliseconds.
 * In-progress spans (no end_time) measure against now() so live bars grow.
 */
export function getSpanDuration(span: Span): number | null {
  if (!span.span_start_time) return null;
  const start = parseTimestamp(span.span_start_time);
  const end = span.span_end_time ? parseTimestamp(span.span_end_time) : Date.now();
  return Math.max(0, end - start);
}

/**
 * Calculate trace duration as the full span extent: max(end) − min(start)
 * across all spans (in-progress spans measure against now() so live traces grow).
 *
 * We don't use the root span's own duration as the window: a root span can
 * finish well before its descendants (e.g. a streaming handler that returns its
 * response while work continues in the background), and dividing the timeline by
 * that short duration pushes every child bar far past the viewport. The root
 * duration is kept only as a floor so a still-open root doesn't collapse the
 * window. Matches the backend trace-list query (min start → max end).
 */
export function getTraceDuration(trace: TraceDetail): number | null {
  const allSpans = enrichSpansWithPending(trace.spans);
  if (!allSpans.length) return null;

  const now = Date.now();
  const minStart = Math.min(...allSpans.map((s) => parseTimestamp(s.span_start_time)));
  const maxEnd = Math.max(
    ...allSpans.map((s) => (s.span_end_time ? parseTimestamp(s.span_end_time) : now)),
  );
  const extent = Math.max(0, maxEnd - minStart);

  const root = allSpans.find((s) => !s.parent_span_id);
  const rootDuration = root ? (getSpanDuration(root) ?? 0) : 0;

  return Math.max(rootDuration, extent);
}

/**
 * Build a linearized tree structure from spans for rendering
 */
export function buildSpanTree(spans: Span[]): SpanTreeRow[] {
  const childrenByParent = new Map<string | null, Span[]>();
  const spanIds = new Set(spans.map((s) => s.span_id));

  spans.forEach((span) => {
    const pid = span.parent_span_id;
    if (!childrenByParent.has(pid)) childrenByParent.set(pid, []);
    childrenByParent.get(pid)!.push(span);
  });

  // Sort children within each parent by start_time so connector lines
  // (isTerminal / parentLevels) are stable regardless of SSE arrival order.
  for (const children of childrenByParent.values()) {
    children.sort(compareSpansForStableDisplay);
  }

  const rows: SpanTreeRow[] = [];

  function traverse(span: Span, level: number, isTerminal: boolean, parentLevels: number[]) {
    rows.push({ span, level, isTerminal, parentLevels });
    const children = childrenByParent.get(span.span_id) || [];
    children.forEach((child, idx) => {
      const childIsTerminal = idx === children.length - 1;
      const nextParentLevels = childIsTerminal ? parentLevels : [...parentLevels, level];
      traverse(child, level + 1, childIsTerminal, nextParentLevels);
    });
  }

  // Combine true roots with orphan spans (parent not yet arrived) into a single
  // top-level list sorted by start_time. This ensures:
  // 1. Connector lines are correct across all top-level items.
  // 2. Orphans are always visible, not silently dropped when root exists.
  const orphans = spans.filter((s) => s.parent_span_id !== null && !spanIds.has(s.parent_span_id));
  const topLevel = [...(childrenByParent.get(null) ?? []), ...orphans].sort(compareSpansForStableDisplay);
  topLevel.forEach((span, idx) => {
    traverse(span, 0, idx === topLevel.length - 1, []);
  });

  return rows;
}

/**
 * Build children map for checking if spans have children
 */
export function buildChildrenMap(spans: Span[]): Map<string | null, Span[]> {
  const childrenByParent = new Map<string | null, Span[]>();
  spans.forEach((span) => {
    const pid = span.parent_span_id;
    if (!childrenByParent.has(pid)) childrenByParent.set(pid, []);
    childrenByParent.get(pid)!.push(span);
  });
  return childrenByParent;
}

/**
 * Truncate text with ellipsis
 */
export function truncateText(text: string | null, maxLength: number = 50): string {
  if (!text) return "-";
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + "...";
}

/**
 * Format content preview, attempting JSON parsing
 */
export function formatContentPreview(text: string | null): string {
  if (!text) return "-";
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === "object") {
      const preview = JSON.stringify(parsed).substring(0, 80);
      return preview.length < JSON.stringify(parsed).length ? preview + "..." : preview;
    }
    return truncateText(String(parsed), 80);
  } catch {
    return truncateText(text, 80);
  }
}

/**
 * Calculate total cost from all spans in a trace
 */
export function getTraceTotalCost(trace: TraceDetail): number | null {
  const costs = trace.spans
    .filter((s) => s.cost != null && Number.isFinite(s.cost))
    .map((s) => s.cost!);
  if (costs.length === 0) return null;
  return costs.reduce((sum, cost) => sum + cost, 0);
}

/**
 * Check if a trace has any errored spans
 */
export function getTraceHasError(trace: TraceDetail): boolean {
  return trace.spans.some((s) => s.status === SpanStatus.ERROR);
}

/**
 * Calculate total token usage from all spans in a trace
 */
export function getTraceTokenUsage(trace: TraceDetail): {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
} | null {
  const spansWithTokens = trace.spans.filter((s) => s.total_tokens !== null);
  if (spansWithTokens.length === 0) return null;
  // Preserve the unknown-vs-zero distinction: only coerce input/output to a
  // number when at least one span actually reports it, so a total-only trace
  // renders "-" (via formatTokenFlow) instead of a misleading 0.
  const hasInput = spansWithTokens.some((s) => s.input_tokens !== null);
  const hasOutput = spansWithTokens.some((s) => s.output_tokens !== null);
  const acc = spansWithTokens.reduce(
    (acc, s) => {
      acc.inputTokens += s.input_tokens ?? 0;
      acc.outputTokens += s.output_tokens ?? 0;
      acc.totalTokens += s.total_tokens ?? 0;
      acc.cacheReadTokens += s.usage_details?.cache_read_tokens ?? 0;
      acc.cacheWriteTokens += s.usage_details?.cache_write_tokens ?? 0;
      acc.reasoningTokens += s.usage_details?.reasoning_tokens ?? 0;
      return acc;
    },
    {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    },
  );
  return {
    ...acc,
    inputTokens: hasInput ? acc.inputTokens : null,
    outputTokens: hasOutput ? acc.outputTokens : null,
  };
}

// Cost breakdown categories stored in cost_details. Used by
// getTraceCostBreakdown to aggregate across spans; summarizeCostDetails reads
// these same keys explicitly.
const COST_DETAIL_KEYS = [
  "input_uncached_cost",
  "cache_read_cost",
  "cache_write_cost",
  "output_cost",
] as const;

/**
 * Group a span's (or a merged trace's) per-category cost_details into the
 * input/output sections shown in the cost breakdown popup. Input
 * cost is the sum of uncached, cache-read and cache-write costs; total is input +
 * output. Missing keys default to 0.
 */
export function summarizeCostDetails(details: Record<string, number> | undefined | null): {
  inputUncachedCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  inputCost: number;
  outputCost: number;
  total: number;
} {
  const inputUncachedCost = details?.input_uncached_cost ?? 0;
  const cacheReadCost = details?.cache_read_cost ?? 0;
  const cacheWriteCost = details?.cache_write_cost ?? 0;
  const outputCost = details?.output_cost ?? 0;
  const inputCost = inputUncachedCost + cacheReadCost + cacheWriteCost;
  return {
    inputUncachedCost,
    cacheReadCost,
    cacheWriteCost,
    inputCost,
    outputCost,
    total: inputCost + outputCost,
  };
}

/**
 * Sum each cost_details category across a trace's spans for the trace-level cost
 * popup (mirrors getTraceTokenUsage). Returns null when no span reports a
 * breakdown, so the trace cost chip renders without a popup.
 */
export function getTraceCostBreakdown(trace: TraceDetail): Record<string, number> | null {
  const spansWithDetails = trace.spans.filter(
    (s) => s.cost_details && Object.keys(s.cost_details).length > 0,
  );
  if (spansWithDetails.length === 0) return null;
  const merged: Record<string, number> = {};
  for (const key of COST_DETAIL_KEYS) {
    merged[key] = spansWithDetails.reduce((sum, s) => sum + (s.cost_details?.[key] ?? 0), 0);
  }
  return merged;
}

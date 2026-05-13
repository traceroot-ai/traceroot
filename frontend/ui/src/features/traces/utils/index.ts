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

    const meta = parseMetadata(span.metadata);
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
 * Calculate trace duration from all spans.
 * Prefer the root span's own start/end to avoid skew from child spans with
 * bad timestamps (e.g. LangGraph task spans). Falls back to min(start)..max(end)
 * across non-pending spans; in-progress spans measure against now() so live
 * traces grow.
 */
export function getTraceDuration(trace: TraceDetail): number | null {
  const allSpans = enrichSpansWithPending(trace.spans);
  if (!allSpans.length) return null;

  const root = allSpans.find((s) => !s.parent_span_id);
  if (root) {
    return getSpanDuration(root);
  }

  const now = Date.now();
  const minStart = Math.min(...allSpans.map((s) => parseTimestamp(s.span_start_time)));
  const maxEnd = Math.max(
    ...allSpans.map((s) => (s.span_end_time ? parseTimestamp(s.span_end_time) : now)),
  );
  return Math.max(0, maxEnd - minStart);
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
    children.sort((a, b) => parseTimestamp(a.span_start_time) - parseTimestamp(b.span_start_time));
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
  const topLevel = [...(childrenByParent.get(null) ?? []), ...orphans].sort(
    (a, b) => parseTimestamp(a.span_start_time) - parseTimestamp(b.span_start_time),
  );
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
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
} | null {
  const spansWithTokens = trace.spans.filter((s) => s.total_tokens !== null);
  if (spansWithTokens.length === 0) return null;
  return {
    inputTokens: spansWithTokens.reduce((sum, s) => sum + (s.input_tokens ?? 0), 0),
    outputTokens: spansWithTokens.reduce((sum, s) => sum + (s.output_tokens ?? 0), 0),
    totalTokens: spansWithTokens.reduce((sum, s) => sum + (s.total_tokens ?? 0), 0),
  };
}

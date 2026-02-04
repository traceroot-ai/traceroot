/**
 * Trace feature utilities
 */
import type { Span, TraceDetail } from "@/types/api";
import type { SpanTreeRow } from "../types";

// Layout constants for tree alignment
export const TREE_LAYOUT = {
  NESTING_INDENT: 22,  // Space per nesting level
  ROW_HEIGHT: 28,      // Height of each row (compact)
  ICON_BOX_SIZE: 18,   // Size of icon box
  LEFT_PADDING: 8,     // Left padding before first icon
} as const;

/**
 * Calculate span duration in milliseconds
 */
export function getSpanDuration(span: Span): number | null {
  if (!span.span_start_time || !span.span_end_time) return null;
  return new Date(span.span_end_time).getTime() - new Date(span.span_start_time).getTime();
}

/**
 * Calculate trace duration from all spans
 */
export function getTraceDuration(trace: TraceDetail): number | null {
  if (!trace.spans.length) return null;
  const startTimes = trace.spans.map((s) => new Date(s.span_start_time).getTime());
  const endTimes = trace.spans
    .filter((s) => s.span_end_time)
    .map((s) => new Date(s.span_end_time!).getTime());
  if (!endTimes.length) return null;
  return Math.max(...endTimes) - Math.min(...startTimes);
}

/**
 * Build a linearized tree structure from spans for rendering
 */
export function buildSpanTree(spans: Span[]): SpanTreeRow[] {
  const childrenByParent = new Map<string | null, Span[]>();
  spans.forEach((span) => {
    const pid = span.parent_span_id;
    if (!childrenByParent.has(pid)) childrenByParent.set(pid, []);
    childrenByParent.get(pid)!.push(span);
  });

  const rows: SpanTreeRow[] = [];

  function traverse(span: Span, level: number, isTerminal: boolean, parentLevels: number[]) {
    rows.push({ span, level, isTerminal, parentLevels });
    const children = childrenByParent.get(span.span_id) || [];
    children.forEach((child, idx) => {
      const childIsTerminal = idx === children.length - 1;
      const nextParentLevels = isTerminal ? parentLevels : [...parentLevels, level];
      traverse(child, level + 1, childIsTerminal, nextParentLevels);
    });
  }

  const roots = childrenByParent.get(null) || [];
  roots.forEach((root, idx) => {
    traverse(root, 0, idx === roots.length - 1, []);
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
  if (!text) return '-';
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}

/**
 * Format content preview, attempting JSON parsing
 */
export function formatContentPreview(text: string | null): string {
  if (!text) return '-';
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'object') {
      const preview = JSON.stringify(parsed).substring(0, 80);
      return preview.length < JSON.stringify(parsed).length ? preview + '...' : preview;
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
  const costs = trace.spans.filter((s) => s.cost !== null && s.cost > 0).map((s) => s.cost!);
  if (costs.length === 0) return null;
  return costs.reduce((sum, cost) => sum + cost, 0);
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

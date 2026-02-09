/**
 * Trace feature types
 */
import type { Span } from "@/types/api";

// Selection state for trace/span detail views
export type TraceSelection = { type: "trace" } | { type: "span"; span: Span };

// Linearized span row for tree rendering
export interface SpanTreeRow {
  span: Span;
  level: number;
  isTerminal: boolean; // Last child of parent (for L-shaped connector)
  parentLevels: number[]; // Ancestor levels that need continuing vertical lines
}

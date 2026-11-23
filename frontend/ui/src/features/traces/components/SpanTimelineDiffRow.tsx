"use client";

import type { CSSProperties } from "react";
import { MODEL_SPAN_KINDS, SpanKind, SpanStatus } from "@traceroot/core";
import type { UnionNode } from "@/lib/eval/union-tree";
import { cn, formatDuration } from "@/lib/utils";
import type { DiffBar } from "../utils/diff";
import { getSpanKindColor } from "./SpanKindIcon";

/** The baseline's bar behind this trace's: an outline, so the bar in front stays legible.
 *  A click on it is the row's. */
export function GhostBar({
  left,
  width,
  durationMs,
}: {
  left: string;
  width: string;
  durationMs: number;
}) {
  return (
    <div
      data-diff-ghost
      className="absolute z-[5] rounded-[2px] border border-dashed border-foreground/30 bg-foreground/[0.06]"
      style={{ left, width, height: "24px" }}
      title={`Baseline: ${formatDuration(durationMs)}`}
    />
  );
}

/**
 * One node of the union of two traces on the timeline: this trace's span as its usual bar,
 * with the baseline's span as a ghost behind it, either alone on a span only one run has.
 */
export function SpanTimelineDiffRow({
  node,
  bar,
  ghost,
  toPx,
  style,
  selected,
  hovered,
  onSelect,
  onMouseEnter,
  onMouseLeave,
}: {
  node: UnionNode;
  bar: DiffBar | null;
  ghost: DiffBar | null;
  /** Milliseconds from the start of the run to pixels on this timeline. */
  toPx: (ms: number) => number;
  style: CSSProperties;
  selected: boolean;
  hovered: boolean;
  onSelect: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const span = node.candidate ?? node.baseline;
  // The same spans name their duration as on a plain row.
  const showDuration =
    MODEL_SPAN_KINDS.has(span.span_kind) ||
    span.span_kind === SpanKind.TOOL ||
    span.parent_span_id === null;
  const shown = bar ?? ghost!;
  const width = bar ? toPx(bar.durationMs) : 0;
  const isInstant = !!bar && !bar.inProgress && width < 2;
  return (
    <div
      data-diff-state={node.state}
      className={cn(
        "group absolute left-0 top-0 z-10 flex w-full cursor-pointer items-center border-b border-border/5 transition-colors",
        hovered ? "bg-muted" : "bg-transparent",
        selected && "bg-accent",
      )}
      style={style}
      onMouseEnter={(e) => {
        e.stopPropagation();
        onMouseEnter();
      }}
      onMouseLeave={(e) => {
        e.stopPropagation();
        onMouseLeave();
      }}
      onClick={onSelect}
    >
      {showDuration && (
        <span className="absolute left-2 z-20 whitespace-nowrap text-[12px] text-muted-foreground">
          {formatDuration(shown.durationMs)}
        </span>
      )}
      {ghost && (
        <GhostBar
          left={`${Math.max(0, toPx(ghost.offsetMs))}px`}
          width={`${Math.max(4, toPx(ghost.durationMs))}px`}
          durationMs={ghost.durationMs}
        />
      )}
      {bar &&
        (isInstant ? (
          <div
            data-diff-bar
            className="absolute z-10 h-3 w-[2px] bg-muted-foreground/50 transition-colors"
            style={{ left: `${Math.max(0, toPx(bar.offsetMs))}px` }}
          />
        ) : (
          <div
            data-diff-bar
            className={cn(
              "absolute z-10 overflow-hidden rounded-[2px] transition-colors",
              span.status === SpanStatus.ERROR
                ? "bg-red-200 dark:bg-red-950/60"
                : getSpanKindColor(span.span_kind).surface,
              bar.inProgress && "animate-pulse border border-dashed opacity-70",
              selected && "brightness-95",
            )}
            style={{
              left: `${Math.max(0, toPx(bar.offsetMs))}px`,
              width: `${Math.max(4, width)}px`,
              height: "24px",
            }}
          />
        ))}
    </div>
  );
}

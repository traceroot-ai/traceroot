"use client";

import * as React from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { changeSentiment, SENTIMENT_CLASS } from "@/features/offline-eval/utils";
import type { ScorerDirection } from "@/lib/eval/comparison";
import { cn } from "@/lib/utils";
import { CELL_STATE_LABEL, type CellState } from "./cell-state";

/** The pinned Input column has a fixed width, so the Run column can be pinned right after
 *  it (`RUN_COLUMN`'s offset). */
export const INPUT_COLUMN = "w-[240px] min-w-[240px] max-w-[240px]";
/** The Run column, pinned beside Input. */
export const RUN_COLUMN = "sticky left-[240px] z-[1] whitespace-nowrap";
/** The comparison table. Unlike the app's other tables it rules its columns: a case is a
 *  stack of lines, text and numbers side by side across many columns, and the rules keep
 *  each value in its column. A row's last cell ends at the table's edge and draws none.
 *  Rows are ruled per case (`GROUP_EDGE`), not per line. */
export const COMPARISON_TABLE =
  "sticky-sep [&_td]:!border-r [&_th]:!border-r [&_tr>*:last-child]:!border-r-0";
/** A pinned body cell's fill, which has to follow its case group's: plain or hovered. */
export const PINNED_FILL = "bg-background group-hover/row:bg-muted";

/** A run's line in a group (a case, or the summary). The table's cell rule sets a fixed
 *  height and no vertical padding; a line sets its own, the group's first and last lines
 *  leaving room above and below it. */
export function lineClass(first: boolean, last: boolean): string {
  return cn("[&>*]:!h-auto [&>*]:!py-0.5", first && "[&>*]:!pt-1.5", last && "[&>*]:!pb-1.5");
}

/** The rule under a group, also drawn by the cells spanning it. Each group is a tbody of
 *  its own, and the shared `sticky-sep` rule clears the bottom border of a tbody's last
 *  row, style included, which `border-b` alone doesn't set back. */
export const GROUP_EDGE = "!border-b ![border-bottom-style:solid] !border-border";
/** A line's cell edge: no rule between a group's lines, a full one under its last. */
export const lineEdge = (last: boolean) => (last ? GROUP_EDGE : "!border-b-0");

/** One coloured dot for a run, named for assistive tech and on hover so colour isn't the
 *  only way to tell the runs apart. */
export function Dot({ color }: { color: string }) {
  return <span className={cn("h-2 w-2 shrink-0 rounded-full", color)} aria-hidden />;
}

/** The run a value belongs to: its label for screen readers, and on hover. */
export function RunLabel({ label }: { label: string }) {
  return <span className="sr-only select-none">{label}: </span>;
}

/** A signed, direction-aware delta vs the baseline (green = better, red = worse; a metric
 *  with no direction is never coloured). */
export function Delta({
  value,
  text,
  direction,
}: {
  value: number;
  /** The change as shown, sign included. */
  text: string;
  direction: ScorerDirection;
}) {
  // A change that rounds to nothing is shown unsigned; drop it rather than print "0ms".
  if (value === 0 || !/^[+−]/.test(text)) return null;
  const sentiment =
    direction !== "none" ? changeSentiment(value, direction === "higher_is_better") : "neutral";
  return <span className={cn("ml-1", SENTIMENT_CLASS[sentiment])}>{text}</span>;
}

/** Text cut off at the cell's edge, with its full value on hover (no click, no chrome). */
export function TextValue({ text }: { text: string | null }) {
  const t = text?.trim();
  if (!text || !t) return <span className="text-muted-foreground">—</span>;
  return <ClippedText text={t} />;
}

/** One line of text, cut off at the cell's edge, with its full value on hover. The
 *  tooltip's content is built only while it is open. */
function ClippedText({ text: t }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="relative block max-w-full cursor-default truncate">{t}</span>
      </TooltipTrigger>
      <TooltipContent
        align="start"
        side="bottom"
        className="max-h-[420px] w-[460px] max-w-[80vw] overflow-auto whitespace-pre-wrap break-words border bg-popover p-3 font-mono text-[12px] leading-relaxed text-popover-foreground shadow-[0_4px_12px_rgba(11,16,21,0.08)]"
      >
        {t}
      </TooltipContent>
    </Tooltip>
  );
}

/** In place of a value: why the run has none, with the error's own message on hover. */
export function CellStateLabel({ state }: { state: Exclude<CellState, { kind: "value" }> }) {
  const label = CELL_STATE_LABEL[state.kind];
  const message = "message" in state ? state.message : "";
  if (!message) return <span className="text-muted-foreground">{label}</span>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} data-tooltip-trigger className="cursor-default text-muted-foreground">
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        className="max-w-[320px] whitespace-pre-wrap break-words text-left"
      >
        {message}
      </TooltipContent>
    </Tooltip>
  );
}

/** One value per run, stacked and colour-keyed (in baseline-first display order). */
export function RunStack({
  values,
  align = "left",
  tooltipped = false,
}: {
  values: {
    runId: string;
    dot: string;
    label: string;
    node: React.ReactNode;
  }[];
  align?: "left" | "right";
  /** The values carry their own tooltip, so the native title would stack a second one. */
  tooltipped?: boolean;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5", align === "right" && "items-end")}>
      {values.map((v) => (
        <span
          key={v.runId}
          title={tooltipped ? undefined : v.label}
          className="flex max-w-full items-center gap-1.5"
        >
          <Dot color={v.dot} />
          <span className="min-w-0 truncate">
            <RunLabel label={v.label} />
            {v.node}
          </span>
        </span>
      ))}
    </div>
  );
}

/** The Run cell: the run's dot and tag, its version on hover. It heads its line, so a
 *  screen reader names the run with each value on it. */
export function RunCell({
  dot,
  tag,
  label,
  isBaseline,
  className,
}: {
  dot: string;
  tag: string;
  label: string;
  isBaseline: boolean;
  className: string;
}) {
  return (
    // `!pl-3`: on every line but a group's first, this is the row's first cell, which the
    // table's gutter rule would otherwise pad further than the first line's.
    <th scope="row" className={cn("px-3 !pl-3 text-left align-top font-normal", className)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex cursor-default items-center gap-1.5">
            <Dot color={dot} />
            <span>{tag}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="right">{isBaseline ? `${label} · Baseline` : label}</TooltipContent>
      </Tooltip>
    </th>
  );
}

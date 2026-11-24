"use client";

import * as React from "react";
import { THead, TRHead, Th } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { INPUT_COLUMN, RUN_COLUMN } from "./cells";
import { isShown, metricColumn, type ColumnId, type DisplayPrefs } from "./display";
import type { CompareModel } from "./model";

/**
 * The comparison table's head: one row of column labels, which stays on top while the
 * table scrolls (the summary is the body's first group, and scrolls with the cases). A
 * column the viewer hid has no label. The Input and Run labels stay on the left with their
 * columns.
 */
export function ComparisonHead({
  model,
  display,
}: {
  model: Pick<CompareModel, "scorers">;
  display: DisplayPrefs;
}) {
  const shows = (id: ColumnId) => isShown(display, id);
  return (
    <THead className="static">
      {/* Label row — grey, one line, with a divider below it. */}
      <TRHead className="row-sticky-top">
        <Th className={cn("col-sticky-start", INPUT_COLUMN)}>Input</Th>
        {/* Over the pinned Input cell's layer too, as the label row's start cell. */}
        <Th className={cn(RUN_COLUMN, "!z-[3]")}>Run</Th>
        {shows("output") && <Th className="min-w-[220px]">Output</Th>}
        {shows("expected") && <Th className="min-w-[180px]">Expected</Th>}
        {model.scorers
          .filter((s) => shows(metricColumn(s.name)))
          .map((s) => (
            <Th key={s.name} className="w-[130px] text-right">
              {s.name}
            </Th>
          ))}
        {shows("latency") && <Th className="w-[120px] text-right">Latency (mean)</Th>}
        {shows("cost") && <Th className="w-[120px] text-right">Cost (mean)</Th>}
      </TRHead>
    </THead>
  );
}

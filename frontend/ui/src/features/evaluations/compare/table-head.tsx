"use client";

import * as React from "react";
import { THead, TRHead, Th } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { INPUT_COLUMN, RUN_COLUMN } from "./cells";
import type { CompareModel } from "./model";

/**
 * The comparison table's head: one row of column labels, which stays on top while the
 * table scrolls (the summary is the body's first group, and scrolls with the cases). The
 * Input and Run labels stay on the left with their columns.
 */
export function ComparisonHead({ model }: { model: Pick<CompareModel, "scorers"> }) {
  return (
    <THead className="static">
      {/* Label row — grey, one line, with a divider below it. */}
      <TRHead className="row-sticky-top">
        <Th className={cn("col-sticky-start", INPUT_COLUMN)}>Input</Th>
        {/* Over the pinned Input cell's layer too, as the label row's start cell. */}
        <Th className={cn(RUN_COLUMN, "!z-[3]")}>Run</Th>
        <Th className="min-w-[220px]">Output</Th>
        <Th className="min-w-[180px]">Expected</Th>
        {model.scorers.map((s) => (
          <Th key={s.name} className="w-[130px] text-right">
            {s.name}
          </Th>
        ))}
        <Th className="w-[120px] text-right">Latency (mean)</Th>
        <Th className="w-[120px] text-right">Cost (mean)</Th>
      </TRHead>
    </THead>
  );
}

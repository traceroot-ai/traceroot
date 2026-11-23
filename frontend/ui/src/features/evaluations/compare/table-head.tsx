"use client";

import * as React from "react";
import { THead, TRHead, Th } from "@/components/ui/table";
import { INPUT_COLUMN, RUN_COLUMN } from "./cells";
import type { CompareModel } from "./model";

/**
 * The comparison table's head: one row of column labels, which stays on top while the
 * table scrolls (the summary is the body's first group, and scrolls with the cases).
 */
export function ComparisonHead({ model }: { model: Pick<CompareModel, "scorers"> }) {
  return (
    <THead>
      {/* Label row — grey, one line, with a divider below it. */}
      <TRHead>
        <Th className={INPUT_COLUMN}>Input</Th>
        <Th className={RUN_COLUMN}>Run</Th>
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

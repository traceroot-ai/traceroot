"use client";

import * as React from "react";
import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { coverageSummary, partialNotesLine, partialRunNotes } from "./coverage";
import type { CompareModel } from "./model";

/**
 * Under the toolbar, one muted line: how many cases the comparison holds and how many
 * every run has. Then the runs whose results fall short of the cases they declared: the
 * run's own note when it is one, else how many, each run's note on hover.
 */
export function ScopeLine({
  model,
  tagOf,
}: {
  model: CompareModel;
  tagOf: (runId: string) => string;
}) {
  const total = model.cases.length;
  // Runs whose results fall short of the cases they declared, and why, in one line.
  const partialNotes = partialRunNotes(model.runs, tagOf);
  const partialLine = partialNotesLine(partialNotes);
  return (
    <p className="border-b border-border px-4 py-1.5 text-[12px] text-muted-foreground">
      <span>{coverageSummary({ total, sharedByAll: model.sharedByAllCount })}</span>
      {partialLine && (
        <>
          <span aria-hidden> · </span>
          {partialNotes.length > 1 ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0} className="inline-flex cursor-default items-center gap-1">
                  {partialLine}
                  <Info className="h-3 w-3" aria-hidden />
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="start" className="max-w-[360px] text-left">
                <ul>
                  {/* By position: two runs' notes can read the same when their tags do. */}
                  {partialNotes.map((note, i) => (
                    <li key={i}>{note}</li>
                  ))}
                </ul>
              </TooltipContent>
            </Tooltip>
          ) : (
            <span>{partialLine}</span>
          )}
        </>
      )}
    </p>
  );
}

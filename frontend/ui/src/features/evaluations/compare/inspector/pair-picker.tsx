"use client";

import * as React from "react";
import { ArrowLeftRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Dot } from "../cells";
import type { RunBundle } from "../model";

/** The trace panel's two runs: a Baseline and a Candidate picked from the runs compared,
 *  and a swap between them. Local to the panel; the table's baseline stays as it is. */
export function PairPicker({
  runs,
  pair,
  tagOf,
  dotFor,
  onChange,
}: {
  runs: readonly RunBundle[];
  /** `[baseline, candidate]` run ids. */
  pair: readonly [string, string];
  tagOf: (runId: string) => string;
  dotFor: (runId: string) => string;
  onChange: (pair: [string, string]) => void;
}) {
  const [baseline, candidate] = pair;
  const side = (label: "Baseline" | "Candidate", value: string, other: string) => (
    <div className="flex items-center gap-1.5">
      <span className="text-muted-foreground">{label}</span>
      <Select
        value={value}
        onValueChange={(runId) =>
          onChange(label === "Baseline" ? [runId, candidate] : [baseline, runId])
        }
      >
        <SelectTrigger aria-label={`${label} run`} className="h-7 w-[140px] text-[12px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {runs.map(({ run }) => (
            // The run on the other side can't be on this one too.
            <SelectItem key={run.id} value={run.id} disabled={run.id === other}>
              <span className="flex min-w-0 items-center gap-1.5">
                <Dot color={dotFor(run.id)} />
                <span className="truncate">
                  {tagOf(run.id)} {run.candidateVersion}
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <div className="flex shrink-0 items-center gap-2">
      {side("Baseline", baseline, candidate)}
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-7 p-0"
        onClick={() => onChange([candidate, baseline])}
        aria-label="Swap baseline and candidate"
        title="Swap baseline and candidate"
      >
        <ArrowLeftRight className="h-3.5 w-3.5" />
      </Button>
      {side("Candidate", candidate, baseline)}
    </div>
  );
}

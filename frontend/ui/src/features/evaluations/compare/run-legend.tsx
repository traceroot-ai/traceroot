"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EVAL_RUN_STATUS_LABEL } from "../types";
import { Dot } from "./cells";
import type { RunBundle } from "./model";

/**
 * One chip per compared run, in table order (baseline first), listed down the Runs menu:
 * its colour, `#N version`, its status unless it completed, and a "Baseline" badge on the
 * baseline. Each chip's menu makes the run the baseline, removes it from the comparison,
 * or opens it. `trailing` (Add runs) follows the last chip.
 */
export function RunLegend({
  projectId,
  runs,
  baselineRunId,
  dotFor,
  tagOf,
  canRemove,
  onSetBaseline,
  onRemove,
  trailing,
}: {
  projectId: string;
  runs: readonly RunBundle[];
  baselineRunId: string;
  dotFor: (runId: string) => string;
  /** "#2", or "support-routing #2" when the runs span evaluations. */
  tagOf: (runId: string) => string;
  /** False once only two runs are left to compare. */
  canRemove: boolean;
  onSetBaseline: (runId: string) => void;
  onRemove: (runId: string) => void;
  trailing?: React.ReactNode;
}) {
  return (
    <div role="group" aria-label="Runs in this comparison" className="flex flex-col gap-0.5">
      {runs.map(({ run }) => {
        const isBaseline = run.id === baselineRunId;
        return (
          <DropdownMenu key={run.id}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex h-8 w-full items-center gap-1.5 whitespace-nowrap rounded-[2px] px-2 text-left text-[12px] hover:bg-muted focus-visible:bg-muted focus-visible:outline-none data-[state=open]:bg-muted"
              >
                <Dot color={dotFor(run.id)} />
                <span className="shrink-0">{`${tagOf(run.id)} ${run.candidateVersion}`}</span>
                {run.status !== "completed" && (
                  <span className="text-muted-foreground">{EVAL_RUN_STATUS_LABEL[run.status]}</span>
                )}
                {isBaseline && <Badge variant="outline">Baseline</Badge>}
                <ChevronDown className="ml-auto h-3 w-3 text-muted-foreground" aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48">
              <DropdownMenuItem disabled={isBaseline} onSelect={() => onSetBaseline(run.id)}>
                Set as baseline
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!canRemove} onSelect={() => onRemove(run.id)}>
                Remove from comparison
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href={`/projects/${projectId}/evaluations/${run.id}`}>Open run</Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        );
      })}
      {trailing}
    </div>
  );
}

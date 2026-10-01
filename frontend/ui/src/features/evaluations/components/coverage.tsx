"use client";

import * as React from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import {
  formatCoverage,
  formatCoverageRatio,
  coverageNote,
  isSubset,
  type RunCoverage,
} from "@/lib/eval/coverage";

/**
 * How a run's dataset coverage reads across the evaluation surfaces.
 *
 * Both pieces are deliberately small and reuse the existing table/badge language
 * (text-[11px], muted chrome, hover-for-detail) rather than introducing a panel of
 * their own: coverage is a qualifier on numbers that already exist, not a new headline.
 * Every string comes from lib/eval/coverage so the list, the detail page and the
 * comparison cannot describe the same run differently.
 */

/**
 * The compact `20 / 500` table cell, with the full label and a note on hover. A subset
 * is muted-but-marked rather than coloured: it is a legitimate thing to do, just not a
 * whole-dataset result. Unknown coverage is marked for information only.
 */
export function CoverageCell({ coverage }: { coverage: RunCoverage }) {
  const reason = coverageNote(coverage);
  const cell = (
    <span className="inline-flex items-center gap-1 tabular-nums">
      {formatCoverageRatio(coverage)}
      {/* One character carries the whole distinction in a dense table: a subset is
          partial, unknown coverage was never reported. Both are spelled out on hover, and
          the role="img" + aria-label names each one for a screen reader, which would
          otherwise skip a label on a generic span and announce the bare glyph. */}
      {isSubset(coverage) && (
        <span
          role="img"
          className="text-[10px] text-amber-700 dark:text-amber-400"
          aria-label="subset run"
        >
          ◗
        </span>
      )}
      {coverage.mode === "unknown" && (
        <span role="img" className="text-muted-foreground" aria-label="coverage unknown">
          ?
        </span>
      )}
    </span>
  );
  if (!reason) return cell;
  return (
    <Tooltip>
      {/* Focusable so a keyboard user can open the explanation, not just a mouse. */}
      <TooltipTrigger asChild>
        <span tabIndex={0} className="cursor-default">
          {cell}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" align="end" className="max-w-[320px]">
        {/* TooltipContent is primary-on-primary, so the two lines separate by weight
            and spacing rather than by a muted colour that would not survive it. */}
        <p className="font-medium">{formatCoverage(coverage)}</p>
        <p className="mt-1 opacity-80">{reason}</p>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The one-line coverage label for a run's own page. Shown for every run, including a
 * full one — a reader who never sees the label cannot tell "full" from "nobody said",
 * which is the ambiguity this whole feature exists to remove.
 */
export function CoverageBadge({ coverage }: { coverage: RunCoverage }) {
  const reason = coverageNote(coverage);
  // Only a known subset is flagged: unknown coverage is shown, but it is not a caveat.
  const badge = (
    <Badge variant={isSubset(coverage) ? "warning" : "default"}>
      {formatCoverage(coverage)}
      {isSubset(coverage) && <span className="opacity-70">· not final</span>}
    </Badge>
  );
  if (!reason) return badge;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="cursor-default">
          {badge}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="max-w-[360px]">
        {reason}
      </TooltipContent>
    </Tooltip>
  );
}

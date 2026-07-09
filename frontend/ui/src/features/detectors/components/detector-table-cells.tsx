"use client";

/**
 * Shared table primitives for the two detector tables — the detector page's
 * runs/findings table (`DetectorRunsTable`) and the trace viewer's detectors
 * table (`TraceDetectorsTab`). Keeping the header/cell classes and the
 * Identified/Summary renderers here means the two stay visually identical and
 * only differ by which columns they show.
 */

/**
 * Header cell classes. Fixed 28px tall (`h-7`) so the header lines up with the
 * trace-tree column header it sits beside in the trace viewer; vertical-align
 * (the table default) centers the label, so no vertical padding is needed.
 */
export const DETECTOR_TH =
  "h-7 whitespace-nowrap border-r border-border/50 px-3 text-left text-[12px] font-medium text-muted-foreground";

/** Body cell classes. */
export const DETECTOR_TD = "border-r border-border/50 px-3 py-1.5 text-[12px]";

/** "Yes" (red) when a run produced a finding, else a muted "No". */
export function IdentifiedBadge({ identified }: { identified: boolean }) {
  return identified ? (
    <span className="text-destructive">Yes</span>
  ) : (
    <span className="text-muted-foreground">No</span>
  );
}

/** Truncated summary text, or an em-dash when there is no summary. */
export function SummaryText({ summary }: { summary: string }) {
  if (!summary) {
    return <span className="font-mono text-[11px] text-muted-foreground">—</span>;
  }
  return (
    <span className="block truncate" title={summary}>
      {summary.length > 100 ? summary.slice(0, 100) + "…" : summary}
    </span>
  );
}

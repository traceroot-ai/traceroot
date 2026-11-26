"use client";

import { cn } from "@/lib/utils";

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
  "h-7 whitespace-nowrap border-r border-border px-3 text-left text-[12px] font-medium text-muted-foreground";

/** Body cell classes. */
export const DETECTOR_TD = "whitespace-nowrap border-r border-border px-3 py-1.5 text-[12px]";

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
    return <span className="font-mono text-[12px] text-muted-foreground">—</span>;
  }
  return (
    <span className="block truncate" title={summary}>
      {summary.length > 100 ? summary.slice(0, 100) + "…" : summary}
    </span>
  );
}

/**
 * One id column's cell. The id itself is the only click target: the inner
 * button opens that id's destination, and the cell's padding, like the rest of
 * the row, does nothing (team UX decision — a link looks like a link, and
 * nothing else in the table reacts to a click).
 *
 * `onOpen` undefined means this id has nothing to open (a run with no
 * self-trace): the cell renders as plain text.
 */
export function IdCell({ id, title, onOpen }: { id: string; title: string; onOpen?: () => void }) {
  return (
    <td className={cn(DETECTOR_TD, "max-w-[9rem] truncate text-muted-foreground")}>
      {onOpen ? (
        <button
          type="button"
          title={title}
          onClick={onOpen}
          className="block max-w-full truncate text-left text-muted-foreground transition-colors hover:text-foreground hover:underline"
        >
          {id}
        </button>
      ) : (
        <span title={title} className="block max-w-full truncate text-muted-foreground">
          {id}
        </span>
      )}
    </td>
  );
}

/** A muted dash for an id cell with nothing to show. */
export function EmptyIdCell() {
  return (
    <td className={cn(DETECTOR_TD, "max-w-[9rem] truncate text-muted-foreground")}>
      <span className="text-muted-foreground">—</span>
    </td>
  );
}

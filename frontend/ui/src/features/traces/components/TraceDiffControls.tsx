"use client";

import type { ReactNode } from "react";
import { GitCompare } from "lucide-react";
import { divergenceCounts, type UnionNode } from "@/lib/eval/union-tree";
import { cn } from "@/lib/utils";

/** The view bar's Diff toggle, a pill like the Trace and Timeline tabs beside it. */
export function DiffToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => onChange(!on)}
      title="Compare each span with the baseline run's trace"
      className={cn(
        "flex items-center gap-1.5 rounded-[2px] px-2.5 py-1.5 text-[13px] font-medium transition-colors",
        on
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <GitCompare className="h-3.5 w-3.5" /> Diff
    </button>
  );
}

/**
 * How the two traces diverge, "2 matched · 1 added · 1 removed", over the run's own spans;
 * or, with no baseline trace to compare with, why not.
 */
export function DivergenceChip({
  nodes,
  unavailable,
}: {
  /** The union of the two traces; null when there is no baseline trace. */
  nodes: readonly UnionNode[] | null;
  unavailable?: ReactNode;
}) {
  const chip = "shrink-0 whitespace-nowrap rounded-md border px-2 py-0.5 text-xs";
  if (!nodes) {
    return (
      <span data-diff-summary className={cn(chip, "text-muted-foreground")}>
        {unavailable ?? "No baseline trace to compare with"}
      </span>
    );
  }
  const { matched, added, removed } = divergenceCounts(nodes);
  return (
    <span
      data-diff-summary
      className={cn(chip, "text-muted-foreground")}
      title="Spans of the run under test. An evaluation's scorer spans aren't counted."
    >
      {matched} matched · <span className={cn(added > 0 && "text-success")}>{added} added</span> ·{" "}
      <span className={cn(removed > 0 && "text-destructive")}>{removed} removed</span>
    </span>
  );
}

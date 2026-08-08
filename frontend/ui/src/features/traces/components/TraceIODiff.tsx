"use client";

import { useMemo } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { ExpandableSection } from "@/components/ui/expandable-section";
import { diffLinesDetailed } from "@/lib/eval/line-diff";

/**
 * A single Input/Output/Metadata section rendered as a git-style line diff of the
 * baseline value vs the candidate value. Used only when the trace viewer is in diff
 * mode (an eval trace with a baseline). Values are pretty-printed before diffing
 * (see `normalizeForDiff`), so a structured payload diffs line-by-line rather than
 * as one long string.
 *
 * Wraps ExpandableSection so it gets the same collapse/minimize chevron as the
 * non-diff I/O sections; the "− baseline / + candidate" (or "unchanged") indicator
 * sits in the header.
 */
export function TraceIODiffSection({
  title,
  baseline,
  candidate,
  loading = false,
  flip = false,
}: {
  title: string;
  baseline: string | null;
  candidate: string | null;
  /** True while either side's I/O fetch is still in flight. Diffing `null` as an
   *  empty baseline/candidate would render a bogus all-added/all-removed diff
   *  before the real value lands, so we show a spinner and skip diffLines entirely. */
  loading?: boolean;
  /** Reverse the diff direction: candidate is the removed (red) side, baseline the added
   *  (green) side — the "Output → Baseline" choice in the run-detail Diff dropdown. */
  flip?: boolean;
}) {
  // `from` is the removed (red) side, `to` the added (green) side.
  const from = flip ? candidate : baseline;
  const to = flip ? baseline : candidate;
  const fromLabel = flip ? "candidate" : "baseline";
  const toLabel = flip ? "baseline" : "candidate";
  const { lines, truncated } = useMemo(
    () => (loading ? { lines: [], truncated: false } : diffLinesDetailed(from ?? "", to ?? "")),
    [from, to, loading],
  );
  const empty = !loading && !(baseline ?? "") && !(candidate ?? "");
  const changed = lines.some((l) => l.type !== "context");

  return (
    <ExpandableSection
      title={title}
      defaultOpen
      headerAction={
        loading || empty ? undefined : changed ? (
          <span className="text-[10px]">
            <span className="text-red-600 dark:text-red-400">− {fromLabel}</span>{" "}
            <span className="text-emerald-600 dark:text-emerald-400">+ {toLabel}</span>
          </span>
        ) : (
          <span className="text-[10px] text-muted-foreground">unchanged</span>
        )
      }
    >
      {loading ? (
        <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Loading…
        </div>
      ) : empty ? (
        <span className="text-[11px] text-muted-foreground">No content</span>
      ) : (
        <>
          {truncated && (
            <p className="mb-1 text-[11px] italic text-muted-foreground">
              Too large to diff line-by-line — showing full {fromLabel} as removed and full{" "}
              {toLabel} as added.
            </p>
          )}
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
            {lines.map((l, i) => (
              <div
                key={i}
                className={cn(
                  // Wrap long lines instead of scrolling sideways (matching the
                  // non-diff I/O sections); the hanging indent keeps wrapped
                  // continuation lines clear of the +/− gutter.
                  "pl-4 -indent-4",
                  l.type === "add" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
                  l.type === "remove" && "bg-red-500/10 text-red-700 dark:text-red-400",
                  l.type === "context" && "text-muted-foreground",
                )}
              >
                <span className="select-none opacity-60">
                  {l.type === "add" ? "+" : l.type === "remove" ? "−" : " "}{" "}
                </span>
                {l.text || " "}
              </div>
            ))}
          </pre>
        </>
      )}
    </ExpandableSection>
  );
}

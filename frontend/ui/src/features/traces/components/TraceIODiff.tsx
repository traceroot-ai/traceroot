"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { diffLines } from "@/lib/eval/line-diff";

/**
 * A single Input/Output/Metadata section rendered as a git-style line diff of the
 * baseline value vs the candidate value. Used only when the trace viewer is in diff
 * mode (an eval trace with a baseline). Values are pretty-printed before diffing
 * (see `normalizeForDiff`), so a structured payload diffs line-by-line rather than
 * as one long string.
 */
export function TraceIODiffSection({
  title,
  baseline,
  candidate,
}: {
  title: string;
  baseline: string | null;
  candidate: string | null;
}) {
  const lines = useMemo(() => diffLines(baseline ?? "", candidate ?? ""), [baseline, candidate]);
  const empty = !(baseline ?? "") && !(candidate ?? "");
  const changed = lines.some((l) => l.type !== "context");

  return (
    <div className="overflow-hidden rounded-md border border-border">
      <div className="flex items-center justify-between border-b border-border bg-muted/40 px-3 py-1.5">
        <span className="text-xs font-medium">{title}</span>
        {!empty &&
          (changed ? (
            <span className="text-[10px]">
              <span className="text-red-600 dark:text-red-400">− baseline</span>{" "}
              <span className="text-emerald-600 dark:text-emerald-400">+ candidate</span>
            </span>
          ) : (
            <span className="text-[10px] text-muted-foreground">unchanged</span>
          ))}
      </div>
      {empty ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">No content</div>
      ) : (
        <pre className="overflow-x-auto whitespace-pre px-3 pb-2 pt-1.5 font-mono text-[11px] leading-relaxed">
          {lines.map((l, i) => (
            <div
              key={i}
              className={cn(
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
      )}
    </div>
  );
}

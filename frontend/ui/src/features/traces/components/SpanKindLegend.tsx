"use client";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { getSpanKindColor } from "./SpanKindIcon";

const LEGEND_KINDS: { kind: string; label: string }[] = [
  { kind: "llm", label: "LLM" },
  { kind: "agent", label: "Agent" },
  { kind: "tool", label: "Tool" },
  { kind: "span", label: "Span" },
];

/**
 * Popover documenting the span_kind → color mapping. Driven by the same palette
 * as the timeline bars and tree icons so it never drifts.
 */
export function SpanKindLegend() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <span className="flex gap-0.5">
            {LEGEND_KINDS.map(({ kind }) => (
              <span
                key={kind}
                className={cn("h-2 w-2 rounded-[1px] border", getSpanKindColor(kind).surface)}
              />
            ))}
          </span>
          Legend
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto p-2">
        <div className="flex flex-col gap-1.5">
          {LEGEND_KINDS.map(({ kind, label }) => (
            <div key={kind} className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span
                className={cn("h-3 w-3 rounded-[2px] border", getSpanKindColor(kind).surface)}
              />
              {label}
            </div>
          ))}
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="h-3 w-3 rounded-[2px] border border-red-300 bg-red-100 dark:border-red-800 dark:bg-red-950/60" />
            Error
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

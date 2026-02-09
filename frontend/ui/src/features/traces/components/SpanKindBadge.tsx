"use client";

import { cn } from "@/lib/utils";

interface SpanKindBadgeProps {
  kind: string;
}

const kindStyles: Record<string, string> = {
  trace: "bg-blue-600 text-white",
  llm: "bg-neutral-800 text-white",
  span: "bg-neutral-500 text-white",
  agent: "bg-neutral-700 text-white",
  tool: "bg-neutral-600 text-white",
};

/**
 * Badge component for displaying span kinds with color coding
 */
export function SpanKindBadge({ kind }: SpanKindBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        kindStyles[kind.toLowerCase()] || "bg-neutral-500 text-white",
      )}
    >
      {kind}
    </span>
  );
}

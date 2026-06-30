"use client";

import { cn } from "@/lib/utils";
import { CopyButton } from "@/components/ui/copy-button";

interface CodeBlockProps {
  /** Sub-heading shown on the left of the header row (e.g. "bash", "python"). */
  label: string;
  /** The text shown in the body and copied by the header copy button. */
  value: string;
  /** Render the body in a monospace font. Defaults to true. */
  mono?: boolean;
}

/**
 * The onboarding code-snippet box: a bordered card with a header row carrying a
 * sub-heading label and the copy button, and the content in a <pre> below. This
 * mirrors the Manual tab's "Initialize TraceRoot" block so every snippet across
 * onboarding shares one style and copy-button placement.
 */
export function CodeBlock({ label, value, mono = true }: CodeBlockProps) {
  return (
    <div className="border border-border">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="text-xs text-muted-foreground">{label}</span>
        <CopyButton value={value} className="h-6 w-6" />
      </div>
      <pre
        className={cn(
          "overflow-x-auto whitespace-pre-wrap bg-muted px-3 py-2.5 text-xs leading-relaxed text-foreground",
          mono && "font-mono",
        )}
      >
        {value}
      </pre>
    </div>
  );
}

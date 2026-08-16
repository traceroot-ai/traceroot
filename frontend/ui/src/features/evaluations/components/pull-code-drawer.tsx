"use client";

import * as React from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { cn } from "@/lib/utils";
import { HighlightedCode } from "@/features/offline-eval/components/syntax";

type Lang = "python" | "typescript";

/** One thing you can pull, in both languages. Only DATA is pullable. */
export interface PullOption {
  id: string;
  label: string;
  /** One-line explanation of exactly what this pulls (resolves latest/exact/none). */
  note?: React.ReactNode;
  py: string;
  ts: string;
}

/**
 * The shared "pull code" slide-out used on BOTH the dataset and run surfaces, so
 * pulling data reads as one pattern. You only pull DATA: a dataset (its current
 * version) or an exact immutable version. An evaluation series or a run id is an
 * identifier, not runnable — those are never options here.
 *
 * When there is more than one option, a small selector switches between them;
 * Python/TypeScript is always a tab toggle.
 */
export function PullCodeDrawer({
  title,
  subtitle,
  options,
  open,
  onOpenChange,
}: {
  title: string;
  subtitle?: React.ReactNode;
  options: PullOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [lang, setLang] = React.useState<Lang>("python");
  const [optionId, setOptionId] = React.useState(options[0]?.id);

  React.useEffect(() => {
    if (open) setOptionId((prev) => (options.some((o) => o.id === prev) ? prev : options[0]?.id));
  }, [open, options]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onOpenChange(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onOpenChange]);

  if (!open) return null;

  const option = options.find((o) => o.id === optionId) ?? options[0];
  const code = lang === "python" ? option.py : option.ts;

  return (
    <div className="animate-slide-in-right fixed inset-y-0 right-0 z-50 flex w-[560px] max-w-[96vw] flex-col border-l border-border bg-background shadow-xl">
      <div className="flex shrink-0 items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-[13px] font-semibold">{title}</h2>
          {subtitle && (
            <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{subtitle}</p>
          )}
        </div>
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          aria-label="Close"
          className="mt-0.5 rounded-sm text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-1 focus:ring-ring"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 pb-6 pt-3 text-[12px]">
        {/* What to pull — only shown when there's a genuine choice. */}
        {options.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            {options.map((o) => (
              <Button
                key={o.id}
                variant={o.id === option.id ? "default" : "outline"}
                size="sm"
                className="h-7 text-[12px]"
                onClick={() => setOptionId(o.id)}
              >
                {o.label}
              </Button>
            ))}
          </div>
        )}

        {option.note && (
          <p className="text-[11px] leading-relaxed text-muted-foreground">{option.note}</p>
        )}

        <div className="overflow-hidden rounded border border-border">
          <div className="flex items-center justify-between border-b border-border bg-muted/50 px-1.5 py-1">
            <div className="flex items-center gap-0.5">
              {(["python", "typescript"] as Lang[]).map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => setLang(l)}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-xs font-medium transition-colors",
                    lang === l
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {l === "python" ? "Python" : "TypeScript"}
                </button>
              ))}
            </div>
            <CopyButton
              value={code}
              className="h-6 w-6 text-muted-foreground hover:text-foreground"
              title="Copy"
            />
          </div>
          {/* Self-contained scroll box + pb-6 so the last line clears the scrollbar. */}
          <HighlightedCode
            code={code}
            className="max-h-[55vh] overflow-auto whitespace-pre px-3 pb-6 pt-2.5 font-mono text-[11px] leading-relaxed"
          />
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-4 py-3">
        <span className="text-[11px] text-muted-foreground">Nothing runs from this panel.</span>
        <Button size="sm" className="h-7 text-[12px]" onClick={() => onOpenChange(false)}>
          Done
        </Button>
      </div>
    </div>
  );
}

"use client";

import { useId, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DiffLayout } from "./ValueDiff";

/**
 * A collapsible box of the span detail panel in diff mode: the same chrome as the panel's
 * Input / Output / Metadata boxes, with room in its header for controls of its own. The
 * title is the toggle, so the controls beside it aren't nested in a button; the box is a
 * region named by it.
 */
export function DiffBox({
  title,
  actions,
  defaultOpen = true,
  flush = false,
  children,
}: {
  title: string;
  /** Controls in the header, right-aligned (a layout toggle, say). */
  actions?: ReactNode;
  defaultOpen?: boolean;
  /** The body runs to the box's edges (a table with its own cell padding). */
  flush?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const titleId = useId();
  return (
    <section
      data-diff-box
      aria-labelledby={titleId}
      className="overflow-hidden rounded-md border border-border"
    >
      <div className="flex w-full items-center justify-between gap-2 border-b border-border px-2.5 py-1.5 transition-colors hover:bg-muted">
        <button
          id={titleId}
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          <span className="text-xs font-medium text-foreground">{title}</span>
        </button>
        {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </div>
      {open && (
        <div className={cn("bg-background text-[12px]", !flush && "px-2.5 py-2")}>{children}</div>
      )}
    </section>
  );
}

/** A small pressed-state choice, as in a box header. */
export function DiffChoice<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  /** What the choice is about, for screen readers. */
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex items-center gap-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-[2px] px-1.5 py-0.5 text-[12px] font-medium transition-colors",
            value === o.value
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const LAYOUTS: { value: DiffLayout; label: string }[] = [
  { value: "columns", label: "Side by side" },
  { value: "inline", label: "Inline" },
];

/** Side by side or inline, for a box whose body is a diff. */
export function DiffLayoutToggle({
  layout,
  onChange,
}: {
  layout: DiffLayout;
  onChange: (layout: DiffLayout) => void;
}) {
  return <DiffChoice label="Diff layout" options={LAYOUTS} value={layout} onChange={onChange} />;
}

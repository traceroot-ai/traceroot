import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Thin wrappers over the raw <table> convention already used across
 * detectors/traces/sessions pages. These carry the same classes that
 * detector-table-cells.tsx exports as DETECTOR_TH / DETECTOR_TD so a new
 * table matches the existing ones without re-typing the strings.
 */

/** Header cell classes — mirrors DETECTOR_TH. */
export const TH =
  "h-7 whitespace-nowrap border-r border-border/50 px-3 text-left text-[12px] font-medium text-muted-foreground last:border-r-0";

/** Body cell classes — mirrors DETECTOR_TD. */
export const TD = "border-r border-border/50 px-3 py-1.5 text-[12px] last:border-r-0";

/** Right-aligned numeric cell (durations, costs, scores). */
export const TD_NUM = cn(TD, "text-right tabular-nums");

/** Monospace identifier cell. */
export const TD_ID = cn(TD, "font-mono text-[11px] text-muted-foreground");

export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return <table className={cn("w-full border-collapse", className)} {...props} />;
}

export function THead({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn("sticky top-0 z-10 bg-background", className)} {...props} />;
}

export function TRHead({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn("border-b border-border bg-muted/50", className)} {...props} />;
}

export function TBody(props: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody {...props} />;
}

export interface TRProps extends React.HTMLAttributes<HTMLTableRowElement> {
  selected?: boolean;
  interactive?: boolean;
}

export function TR({ className, selected, interactive, onClick, onKeyDown, ...props }: TRProps) {
  return (
    <tr
      data-selected={selected ? "true" : undefined}
      // Interactive rows are otherwise mouse-only: no way to reach onClick from
      // the keyboard, and no indication one exists (WCAG 2.1.1). tabIndex + a
      // role + Enter/Space activation give every consumer of `interactive` the
      // same keyboard path a real link/button would have, without each one
      // having to re-implement it.
      tabIndex={interactive && onClick ? 0 : undefined}
      role={interactive && onClick ? "button" : undefined}
      onClick={onClick}
      onKeyDown={(e) => {
        // Only the row itself activates row navigation — a keypress on a nested
        // action (a button/link inside the row) bubbles here, and activating the row
        // too would fire both the action AND the navigation from one Enter/Space.
        if (
          interactive &&
          onClick &&
          e.target === e.currentTarget &&
          (e.key === "Enter" || e.key === " ")
        ) {
          e.preventDefault();
          onClick(e as unknown as React.MouseEvent<HTMLTableRowElement>);
        }
        onKeyDown?.(e);
      }}
      className={cn(
        "border-b border-border/50 transition-colors last:border-0",
        interactive && "cursor-pointer",
        interactive &&
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
        selected ? "bg-muted" : interactive && "hover:bg-muted/50",
        className,
      )}
      {...props}
    />
  );
}

export function Th({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return <th scope="col" className={cn(TH, className)} {...props} />;
}

export function Td({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn(TD, className)} {...props} />;
}

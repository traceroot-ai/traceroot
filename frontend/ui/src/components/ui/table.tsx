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

export function TR({ className, selected, interactive, ...props }: TRProps) {
  return (
    <tr
      data-selected={selected ? "true" : undefined}
      className={cn(
        "border-b border-border/50 transition-colors last:border-0",
        interactive && "cursor-pointer",
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

/** Centered empty-state row spanning the whole table. */
export function TableEmpty({ colSpan, children }: { colSpan: number; children: React.ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-10 text-center text-[12px] text-muted-foreground">
        {children}
      </td>
    </tr>
  );
}

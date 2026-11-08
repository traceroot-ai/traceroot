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
  "h-9 whitespace-nowrap px-3 text-left text-[12px] font-medium text-muted-foreground";

/** Body cell classes — mirrors DETECTOR_TD. */
export const TD = "h-9 whitespace-nowrap px-3 text-[12px]";

/** Right-aligned numeric cell (durations, costs, scores). */
export const TD_NUM = cn(TD, "text-right tabular-nums");

/** Monospace identifier cell. */
export const TD_ID = cn(TD, "font-mono text-[11px] text-muted-foreground");

/**
 * List tables never shrink below this: a narrower screen scrolls the table
 * inside its container instead of crushing the columns.
 */
export const LIST_TABLE_MIN_WIDTH = "min-w-[48rem]";

export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <table className={cn("w-full border-collapse", LIST_TABLE_MIN_WIDTH, className)} {...props} />
  );
}

export function THead({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn("sticky top-0 z-10 bg-background", className)} {...props} />;
}

export function TRHead({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn("border-b border-border bg-muted/60", className)} {...props} />;
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
        selected ? "bg-accent" : interactive && "hover:bg-accent/50",
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

/**
 * A long identifier in a fixed-width cell: the start of the id, truncated, in
 * the data font, with the full value on hover. Ids stay scannable and never
 * stretch a column; the full value is one click away (copy) or in the detail.
 */
export function IdCell({ id, className }: { id: string; className?: string }) {
  return (
    <span
      title={id}
      className={cn(
        "block w-[9ch] truncate font-mono text-[11px] text-muted-foreground",
        className,
      )}
    >
      {id}
    </span>
  );
}

/** Text that may be long: one line, ellipsis, full value on hover. */
export function TruncCell({
  children,
  title,
  className,
}: {
  children: string;
  title?: string;
  className?: string;
}) {
  return (
    <span title={title ?? children} className={cn("block max-w-[28rem] truncate", className)}>
      {children}
    </span>
  );
}

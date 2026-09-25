"use client";

// Column picker for the trace list: every fixed column in `columns.ts`, checked when shown.
// Fields only, and the only way a column reaches the list — metadata is one column holding
// the whole map, never one column per key.
import type { JSX } from "react";
import { Check, Columns3 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { FIXED_COLUMNS, type FixedColumnId } from "@/features/traces/columns";
import { cn } from "@/lib/utils";

const LAST_COLUMN_TITLE = "The list needs at least one column";

interface ColumnPickerProps {
  /** Fixed columns currently shown, in registry order. */
  visibleColumns: FixedColumnId[];
  onToggleField: (id: FixedColumnId) => void;
  onReset: () => void;
}

export function ColumnPicker({
  visibleColumns,
  onToggleField,
  onReset,
}: ColumnPickerProps): JSX.Element {
  // Shown out of available, not a count of what is hidden: a ratio tells the user there is
  // more to turn on.
  const shownCount = visibleColumns.length;
  const totalCount = FIXED_COLUMNS.length;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Choose which fields appear as columns"
          // Sits beside the date filter in the filter bar, so it matches that control's
          // width and height (h-8) exactly rather than reading as a smaller sibling.
          className="flex h-8 min-w-[140px] items-center justify-between gap-2 rounded-md border border-border px-2.5 text-[12px] text-foreground transition-colors hover:border-foreground/40 hover:bg-muted"
        >
          <span className="flex items-center gap-1.5">
            <Columns3 className="h-3.5 w-3.5 text-muted-foreground" />
            Columns
          </span>
          <span className="rounded bg-muted px-1 text-[11px] text-muted-foreground">
            {shownCount}/{totalCount}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" aria-label="Choose columns" className="w-[18rem] p-1">
        <div className="flex flex-col">
          {FIXED_COLUMNS.map((column) => {
            const isVisible = visibleColumns.includes(column.id);
            // A table with no columns has no rows to click, so the last one cannot be hidden.
            const isLastVisible = isVisible && visibleColumns.length === 1;
            return (
              <button
                key={column.id}
                type="button"
                // `aria-pressed` carries the state; the check mark alone is invisible to AT.
                aria-pressed={isVisible}
                disabled={isLastVisible}
                title={isLastVisible ? LAST_COLUMN_TITLE : undefined}
                onClick={() => onToggleField(column.id)}
                className={cn(
                  "flex items-center gap-2 rounded px-2 py-1 text-left text-[13px] transition-colors",
                  isVisible && "bg-muted/40",
                  isLastVisible ? "cursor-not-allowed opacity-50" : "hover:bg-muted/50",
                )}
              >
                <Check
                  aria-hidden="true"
                  className={cn(
                    "h-3.5 w-3.5 shrink-0",
                    isVisible ? "text-foreground" : "text-transparent",
                  )}
                />
                <span className="flex-1 truncate" title={column.label}>
                  {column.label}
                </span>
              </button>
            );
          })}
        </div>
        <div className="mt-1 border-t border-border pt-1">
          <button
            type="button"
            onClick={onReset}
            className="w-full rounded px-2 py-1 text-left text-[12px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            Reset to default
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

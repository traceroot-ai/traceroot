"use client";

import { useState, useEffect } from "react";
import { ChevronLeft, ChevronRight, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface ListPaginationProps {
  page: number;
  limit: number;
  total: number;
  onPageChange: (page: number) => void;
  onLimitChange: (limit: number) => void;
  itemsPerPageOptions?: number[];
  /** Warm an adjacent page on hover/focus of the prev/next buttons. */
  onPrefetchPage?: (page: number) => void;
}

const DEFAULT_OPTIONS = [50, 100, 200];

/**
 * Shared pagination control for list pages (traces, sessions, users, detectors).
 * Items-per-page popover, typeable page input, first/prev/next/last buttons.
 * Renders nothing when `total` is 0 — pages decide whether to mount it.
 */
export function ListPagination({
  page,
  limit,
  total,
  onPageChange,
  onLimitChange,
  itemsPerPageOptions = DEFAULT_OPTIONS,
  onPrefetchPage,
}: ListPaginationProps) {
  const [itemsPerPageOpen, setItemsPerPageOpen] = useState(false);

  // Defend against invalid `limit` propagating from URL/state (0, negative,
  // NaN, Infinity) — without this, `Math.ceil(total / 0)` is Infinity and
  // negative limits give negative `totalPages`, breaking nav controls.
  const safeLimit =
    Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : itemsPerPageOptions[0];
  const totalPages = Math.max(1, Math.ceil(total / safeLimit));

  // Transient string for the input. Lets the field be emptied mid-edit
  // without React snapping it back to the last valid page number.
  const [pageState, setPageState] = useState(String(page + 1));

  // Keep the input in sync when the page changes externally
  // Example: (prev/next/first/last buttons, or parent-driven updates).
  useEffect(() => {
    setPageState(String(page + 1));
  }, [page]);

  if (total <= 0) return null;

  const handlePageInputChange = () => {
    const val = parseInt(pageState, 10);
    if (!isNaN(val)) {
      const clamped = Math.min(Math.max(1, val), totalPages);
      onPageChange(clamped - 1);
      setPageState(String(clamped));
    } else {
      setPageState(String(page + 1)); // Reset to current page if invalid input
    }
  };

  const prefetchPage = (target: number) => {
    if (!onPrefetchPage) return;
    if (target < 0 || target > totalPages - 1 || target === page) return;
    onPrefetchPage(target);
  };

  return (
    <div className="flex flex-wrap items-center justify-end gap-x-6 gap-y-2 border-t border-border bg-background px-4 py-2.5">
      <div className="flex items-center gap-2">
        <span className="text-[12px] text-muted-foreground">Items per page</span>
        <Popover open={itemsPerPageOpen} onOpenChange={setItemsPerPageOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-7 min-w-[60px] justify-between px-2 text-[12px]"
            >
              <span>{limit}</span>
              <ChevronDown className="ml-1 h-3 w-3 text-muted-foreground" />
            </Button>
          </PopoverTrigger>
          <PopoverContent side="top" align="start" className="w-[80px] p-1">
            {itemsPerPageOptions.map((value) => (
              <button
                key={value}
                className={cn(
                  "w-full rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors",
                  limit === value ? "bg-muted" : "hover:bg-muted/50",
                )}
                onClick={() => {
                  onLimitChange(value);
                  setItemsPerPageOpen(false);
                }}
              >
                {value}
              </button>
            ))}
          </PopoverContent>
        </Popover>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[12px] text-muted-foreground">Page</span>
        <input
          type="number"
          min={1}
          max={totalPages}
          value={pageState}
          onChange={(e) => setPageState(e.target.value)}
          onBlur={handlePageInputChange}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur();
            }
          }}
          className="h-7 w-12 rounded border border-border bg-background px-2 py-1 text-center text-[12px] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        <span className="text-[12px] text-muted-foreground">of {totalPages}</span>
      </div>
      <div className="flex items-center gap-0.5">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(0)}
          disabled={page === 0}
          className="h-7 w-7 p-0"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          <ChevronLeft className="-ml-2 h-3.5 w-3.5" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          aria-label="Previous page"
          onClick={() => onPageChange(Math.max(0, page - 1))}
          onMouseEnter={() => prefetchPage(page - 1)}
          onFocus={() => prefetchPage(page - 1)}
          disabled={page === 0}
          className="h-7 w-7 p-0"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          aria-label="Next page"
          onClick={() => onPageChange(page + 1)}
          onMouseEnter={() => prefetchPage(page + 1)}
          onFocus={() => prefetchPage(page + 1)}
          disabled={page >= totalPages - 1}
          className="h-7 w-7 p-0"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(totalPages - 1)}
          disabled={page >= totalPages - 1}
          className="h-7 w-7 p-0"
        >
          <ChevronRight className="h-3.5 w-3.5" />
          <ChevronRight className="-ml-2 h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

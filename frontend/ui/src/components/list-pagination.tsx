"use client";

import { useState } from "react";
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
}: ListPaginationProps) {
  const [itemsPerPageOpen, setItemsPerPageOpen] = useState(false);

  if (total <= 0) return null;

  const totalPages = Math.ceil(total / limit);
  const displayPages = Math.max(1, totalPages);

  return (
    <div className="flex items-center justify-end gap-6 border-t border-border bg-background px-4 py-2.5">
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
          max={displayPages}
          value={page + 1}
          onChange={(e) => {
            const val = parseInt(e.target.value, 10);
            if (!isNaN(val) && val >= 1 && val <= totalPages) {
              onPageChange(val - 1);
            }
          }}
          className="h-7 w-12 rounded border border-border bg-background px-2 py-1 text-center text-[12px] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        <span className="text-[12px] text-muted-foreground">of {displayPages}</span>
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
          onClick={() => onPageChange(Math.max(0, page - 1))}
          disabled={page === 0}
          className="h-7 w-7 p-0"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(page + 1)}
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

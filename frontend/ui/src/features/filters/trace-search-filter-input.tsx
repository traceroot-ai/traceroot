"use client";

/**
 * The combined search-and-filter input: one box that holds the active-filter chips, the
 * keyword text field, and — anchored to it — the filter builder popover.
 *
 * Clicking/focusing the box opens the builder (per "a popup from the search bar"); the
 * popover keeps keyboard focus in the text field (`onOpenAutoFocus` prevented) so you can
 * still type a keyword while it's open. Chips render INSIDE the box, each removable.
 * Replaces the old separate "Add filter" button that sat beside the search bar.
 */
import { useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { Predicate } from "@/types/api";
import { useFilterFields } from "./hooks";
import { FilterBuilder } from "./filter-builder";
import { predicateLabel, upsertPredicate } from "./predicate-ui";

interface TraceSearchFilterInputProps {
  searchValue: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder?: string;
  projectId: string;
  filters: Predicate[];
  onFiltersChange: (filters: Predicate[]) => void;
  /** Active-window bounds, threaded to the lazy distinct-values query. */
  startAfter?: string;
  endBefore?: string;
}

export function TraceSearchFilterInput({
  searchValue,
  onSearchChange,
  searchPlaceholder = "Search or filter…",
  projectId,
  filters,
  onFiltersChange,
  startAfter,
  endBefore,
}: TraceSearchFilterInputProps) {
  const fields = useFilterFields(projectId);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);

  const addPredicate = (p: Predicate) => {
    // Merge into the active set: a lower bound (`greater than`) and an upper bound
    // (`less than`) on the same field coexist to form a range (e.g. latency > 5 and
    // latency < 10, AND-combined by the backend); a same-direction bound, an exact
    // `equals`, a categorical value, or a contradictory opposite bound that would make
    // an empty range (e.g. errors > 5 then errors < 3) is superseded by the new one. The
    // popover stays open and the builder resets, so another filter can be added at once.
    onFiltersChange(upsertPredicate(filters, p));
  };
  const removeAt = (index: number) => onFiltersChange(filters.filter((_, i) => i !== index));

  // Chips show the field's display name (its registry label, lowercased — e.g. `latency`
  // rather than the raw `duration_ms`), falling back to the field key if it isn't loaded.
  const fieldName = (field: string) =>
    fields.find((f) => f.field === field)?.label.toLowerCase() ?? field;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div
          ref={anchorRef}
          className={cn(
            // Match the default SearchFilterBar input exactly: its absolute icon sits at
            // left-2.5 (10px) with text at pl-8 (32px). Here the box has a 1px border, so
            // pl-[9px] (1px border + 9px) puts the icon at the same 10px; mr-1 + gap-1
            // (8px) then lands the text at 32px. Keeps the traces bar identical to
            // users/sessions.
            "flex min-h-8 min-w-[16rem] max-w-2xl flex-1 flex-wrap items-center gap-1 rounded-md",
            "border border-input bg-transparent py-0.5 pl-[9px] pr-2 shadow-sm",
            "focus-within:ring-1 focus-within:ring-ring",
          )}
          onMouseDown={(e) => {
            // Clicking the empty area of the box focuses the text field (which opens the
            // builder); let chip ✕ buttons and the field itself handle their own clicks.
            if (e.target === e.currentTarget) {
              e.preventDefault();
              inputRef.current?.focus();
            }
          }}
        >
          <Search className="mr-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          {filters.map((p, i) => (
            <span
              key={`${p.field}-${i}`}
              className="flex items-center gap-1 rounded bg-muted/70 py-0.5 pl-1.5 pr-1 text-[12px]"
            >
              <span className="font-medium text-foreground">
                {predicateLabel(p, fieldName(p.field))}
              </span>
              <button
                type="button"
                aria-label={`Remove ${p.field} filter`}
                onClick={() => removeAt(i)}
                className="rounded p-0.5 transition-colors hover:bg-muted"
              >
                <X className="h-3 w-3 text-muted-foreground" />
              </button>
            </span>
          ))}
          <input
            ref={inputRef}
            value={searchValue}
            onChange={(e) => onSearchChange(e.target.value)}
            onFocus={() => setOpen(true)}
            onClick={() => setOpen(true)}
            onKeyDown={(e) => {
              // Backspace on an empty text field removes the last filter chip, one per
              // press — the standard tokenized-input behavior.
              if (e.key === "Backspace" && searchValue === "" && filters.length > 0) {
                removeAt(filters.length - 1);
              }
            }}
            placeholder={filters.length === 0 ? searchPlaceholder : "Add filter or search…"}
            className="h-6 min-w-[6rem] flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
          />
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={6}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onInteractOutside={(e) => {
          // Clicking the search box (the anchor, not the content) must NOT close the
          // popover — Radix would otherwise close-then-reopen it, remounting the
          // builder and wiping the user's in-progress selections.
          if (anchorRef.current?.contains(e.target as Node)) e.preventDefault();
        }}
        // z-40 keeps the filter menu above the list but BELOW the trace detail panel
        // (fixed z-50), so it never overlaps on top of an open detail view.
        // Width is 75% of the search bar (left-aligned, so the right ~25% stays
        // uncovered) with a min floor so the field/operator/value/Add-filter row never
        // cramps when the bar itself is narrow.
        className="z-40 w-[calc(var(--radix-popover-trigger-width)*0.75)] min-w-[28rem] p-0"
      >
        <FilterBuilder
          projectId={projectId}
          fields={fields}
          startAfter={startAfter}
          endBefore={endBefore}
          onSubmit={addPredicate}
        />
      </PopoverContent>
    </Popover>
  );
}

import { ArrowDown, ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SortOrder } from "@/types/api";

/** A column header that sorts its table, with an arrow on the sorted column. */
export function SortableHeader({
  label,
  direction,
  onSort,
  className,
}: {
  label: string;
  /** The direction this column is sorted in, or undefined when it is not the sorted one. */
  direction: SortOrder | undefined;
  onSort: () => void;
  className?: string;
}) {
  const Arrow = direction === "asc" ? ArrowUp : ArrowDown;
  return (
    <th
      className={className}
      aria-sort={
        direction === "asc" ? "ascending" : direction === "desc" ? "descending" : undefined
      }
    >
      <button
        type="button"
        onClick={onSort}
        title={`Sort by ${label}`}
        className={cn(
          "inline-flex items-center gap-1 whitespace-nowrap font-medium transition-colors hover:text-foreground",
          direction && "text-foreground",
        )}
      >
        {label}
        {direction && <Arrow className="h-3 w-3 shrink-0" aria-hidden />}
      </button>
    </th>
  );
}

"use client";

import * as React from "react";
import { Trash2 } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * Row selection, the way the reference tables do it: a checkbox
 * column with a select/deselect-all header, and a bar that appears once anything
 * is selected — "N selected", with Delete and any extra actions.
 */
export function useRowSelection<T extends string>(allIds: T[]) {
  const [selected, setSelected] = React.useState<Set<T>>(new Set());

  // Drop ids that no longer exist (e.g. after a local delete).
  React.useEffect(() => {
    setSelected((current) => {
      const next = new Set([...current].filter((id) => allIds.includes(id)));
      return next.size === current.size ? current : next;
    });
  }, [allIds]);

  const toggle = React.useCallback((id: T) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** Add or remove a batch of ids at once (e.g. select every run under a group). */
  const setMany = React.useCallback((ids: T[], on: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const clear = React.useCallback(() => setSelected(new Set()), []);

  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));
  const someSelected = selected.size > 0 && !allSelected;

  const toggleAll = React.useCallback(() => {
    setSelected((current) => (current.size === allIds.length ? new Set() : new Set(allIds)));
  }, [allIds]);

  return {
    selected,
    count: selected.size,
    has: (id: T) => selected.has(id),
    toggle,
    toggleAll,
    setMany,
    clear,
    allSelected,
    someSelected,
  };
}

/** Header checkbox cell — select / deselect all. */
export function SelectAllHeaderCell({
  checked,
  indeterminate,
  onToggle,
}: {
  checked: boolean;
  indeterminate: boolean;
  onToggle: () => void;
}) {
  return (
    <th className="w-8 border-r border-border/50 px-3 py-1.5 text-left">
      <Checkbox
        checked={checked}
        indeterminate={indeterminate}
        onCheckedChange={onToggle}
        aria-label={checked ? "Deselect all" : "Select all"}
      />
    </th>
  );
}

/** Per-row checkbox cell. Stops propagation so it doesn't open the row. */
export function SelectRowCell({
  checked,
  indeterminate,
  onToggle,
  label,
}: {
  checked: boolean;
  /** Mixed state — used on a group row when only some of its member runs are selected. */
  indeterminate?: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <td className="w-8 border-r border-border/50 px-3 py-1.5" onClick={(e) => e.stopPropagation()}>
      <Checkbox
        checked={checked}
        indeterminate={indeterminate}
        onCheckedChange={onToggle}
        aria-label={label}
      />
    </td>
  );
}

/**
 * The bar shown while rows are selected: "N selected", Delete, plus any extra
 * actions. Sits above the table, matching the reference bulk-action pattern.
 *
 * Stays mounted (visually collapsed) even at count 0 so the `aria-live` region
 * is already in the accessibility tree the first time a row is checked —
 * mounting the region and its content in the same tick is not reliably
 * announced by screen readers.
 */
export function BulkActionBar({
  count,
  onDelete,
  onClear,
  extra,
  className,
}: {
  count: number;
  /**
   * Omit on lists with no delete API (e.g. the derived scorer registry).
   * Rejects (or throws) to report failure; the bar owns the confirmation
   * dialog and the pending/disabled state around the call, so callers should
   * not show their own "are you sure" step.
   */
  onDelete?: () => Promise<void>;
  onClear: () => void;
  extra?: React.ReactNode;
  className?: string;
}) {
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);

  const handleConfirm = async () => {
    if (!onDelete) return;
    setPending(true);
    try {
      await onDelete();
      setConfirmOpen(false);
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5",
        count === 0 && "hidden",
        className,
      )}
    >
      {count > 0 && (
        <>
          <span className="text-[12px] font-medium tabular-nums">{count} selected</span>
          {(onDelete || extra) && <span className="h-4 w-px bg-border" aria-hidden />}
          {onDelete && (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-1.5 text-[12px] text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setConfirmOpen(true)}
                disabled={pending}
                aria-label={`Delete ${count} selected`}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
                Delete
              </Button>
              <Dialog open={confirmOpen} onOpenChange={(open) => !pending && setConfirmOpen(open)}>
                <DialogContent className="sm:max-w-md">
                  <DialogHeader>
                    <DialogTitle>
                      Delete {count} run{count === 1 ? "" : "s"}?
                    </DialogTitle>
                    <DialogDescription>This cannot be undone.</DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setConfirmOpen(false)}
                      disabled={pending}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-destructive text-destructive hover:bg-destructive/10"
                      onClick={handleConfirm}
                      disabled={pending}
                    >
                      {pending ? "Deleting…" : `Delete ${count} selected`}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </>
          )}
          {extra}
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-6 px-1.5 text-[12px] text-muted-foreground hover:text-foreground"
            onClick={onClear}
            disabled={pending}
          >
            Clear
          </Button>
        </>
      )}
    </div>
  );
}

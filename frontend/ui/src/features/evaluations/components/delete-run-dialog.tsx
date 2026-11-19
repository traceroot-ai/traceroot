"use client";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/**
 * Confirms deleting one experiment run. A run is immutable history — deleting it
 * removes the run and its per-case results permanently (no undo), so this gates
 * the row's action menu with a plain confirm.
 */
export function DeleteRunDialog({
  runLabel,
  isOpen,
  onClose,
  onConfirm,
  isDeleting,
}: {
  runLabel: string;
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  isDeleting?: boolean;
}) {
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Delete run</DialogTitle>
        </DialogHeader>
        <div className="mt-1 space-y-4">
          <p className="text-[12px] text-muted-foreground">
            This permanently deletes <span className="font-medium text-foreground">{runLabel}</span>{" "}
            and all of its per-case results. This can&apos;t be undone.
          </p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" disabled={isDeleting} onClick={onConfirm}>
              {isDeleting ? "Deleting…" : "Delete"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

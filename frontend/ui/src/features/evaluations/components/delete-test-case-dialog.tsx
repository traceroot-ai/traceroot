"use client";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/**
 * Confirms deleting a single dataset row. Unlike deleting a whole dataset, this
 * only publishes a new version without the row — earlier snapshots keep it — so
 * it's recoverable and doesn't need a type-to-confirm gate, just a plain confirm.
 */
export function DeleteTestCaseDialog({
  rowLabel,
  isOpen,
  onClose,
  onConfirm,
  isDeleting,
}: {
  rowLabel: string;
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  isDeleting?: boolean;
}) {
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[420px]">
        <DialogHeader>
          <DialogTitle className="text-[13px] font-semibold">Delete row</DialogTitle>
        </DialogHeader>
        <div className="mt-1 space-y-4">
          <p className="text-[12px] text-muted-foreground">
            This removes <span className="font-medium text-foreground">{rowLabel}</span> from the
            current version by publishing a new one. Earlier versions still contain it, so any run
            that scored it is unaffected.
          </p>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-[12px]"
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              className="h-7 text-[12px]"
              disabled={isDeleting}
              onClick={onConfirm}
            >
              {isDeleting ? "Deleting…" : "Delete"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

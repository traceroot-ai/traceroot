"use client";

import { useT } from "@/lib/i18n/provider";
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
  const t = useT();
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{t("datasetsDelete.runTitle")}</DialogTitle>
        </DialogHeader>
        <div className="mt-1 space-y-4">
          <p className="text-[12px] text-muted-foreground">
            {t("datasetsDelete.runBefore")}{" "}
            <span className="font-medium text-foreground">{runLabel}</span>{" "}
            {t("datasetsDelete.runAfter")}
          </p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="button" variant="destructive" disabled={isDeleting} onClick={onConfirm}>
              {isDeleting ? t("evalsShared.deleting") : t("common.delete")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n/provider";

interface DeleteDetectorDialogProps {
  detectorName: string;
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  isDeleting?: boolean;
}

export function DeleteDetectorDialog({
  detectorName,
  isOpen,
  onClose,
  onConfirm,
  isDeleting,
}: DeleteDetectorDialogProps) {
  const t = useT();
  const [typed, setTyped] = useState("");

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setTyped("");
      onClose();
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{t("detectorsDelete.title")}</DialogTitle>
        </DialogHeader>

        <div className="mt-1 space-y-4">
          <p className="text-[12px] text-muted-foreground">
            {t("detectorsDelete.confirmBefore")}{" "}
            <span className="font-medium text-foreground">{detectorName}</span>{" "}
            {t("detectorsDelete.confirmAfter")}
          </p>

          <Input
            className="h-8 text-[12px]"
            placeholder={detectorName}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoFocus
          />

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-[12px]"
              onClick={onClose}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              className="h-7 text-[12px]"
              disabled={typed !== detectorName || isDeleting}
              onClick={onConfirm}
            >
              {isDeleting ? t("detectorsDelete.deleting") : t("common.delete")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

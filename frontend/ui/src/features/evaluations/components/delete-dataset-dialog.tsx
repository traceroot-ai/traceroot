"use client";

import { useT } from "@/lib/i18n/provider";
import { Slots } from "@/lib/i18n/slots";
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface DeleteDatasetDialogProps {
  datasetName: string;
  caseCount: number;
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  isDeleting?: boolean;
}

/**
 * Confirms a dataset delete before it fires. Deleting cascades every version
 * and test case (irreversible, no undo), and a mis-click on the row's action
 * menu is otherwise the only thing standing between a dataset and permanent
 * loss — so this mirrors the detector delete flow's type-to-confirm gate.
 */
export function DeleteDatasetDialog({
  datasetName,
  caseCount,
  isOpen,
  onClose,
  onConfirm,
  isDeleting,
}: DeleteDatasetDialogProps) {
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
          <DialogTitle>{t("datasetsDelete.title")}</DialogTitle>
        </DialogHeader>

        <div className="mt-1 space-y-4">
          <p className="text-[12px] text-muted-foreground">
            <Slots
              text={
                caseCount === 1
                  ? t("datasetsDelete.textOne", { count: caseCount })
                  : t("datasetsDelete.textOther", { count: caseCount })
              }
              slots={{ name: <span className="font-medium text-foreground">{datasetName}</span> }}
            />
          </p>

          <Input
            className="h-8 text-[12px]"
            placeholder={datasetName}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoFocus
          />

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={typed !== datasetName || isDeleting}
              onClick={onConfirm}
            >
              {isDeleting ? t("evalsShared.deletingDots") : t("common.delete")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

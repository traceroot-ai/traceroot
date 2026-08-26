"use client";

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
          <DialogTitle className="text-[13px] font-semibold">Delete dataset</DialogTitle>
        </DialogHeader>

        <div className="mt-1 space-y-4">
          <p className="text-[12px] text-muted-foreground">
            This deletes <span className="font-medium text-foreground">{datasetName}</span> and all{" "}
            {caseCount} test case{caseCount === 1 ? "" : "s"} across every version. This action
            cannot be undone. Type{" "}
            <span className="font-medium text-foreground">{datasetName}</span> to confirm.
          </p>

          <Input
            className="h-8 text-[12px]"
            placeholder={datasetName}
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
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              className="h-7 text-[12px]"
              disabled={typed !== datasetName || isDeleting}
              onClick={onConfirm}
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

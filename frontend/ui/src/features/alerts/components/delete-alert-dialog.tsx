"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface DeleteAlertDialogProps {
  alertName: string;
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  isDeleting?: boolean;
  error?: Error | null;
}

export function DeleteAlertDialog({
  alertName,
  isOpen,
  onClose,
  onConfirm,
  isDeleting,
  error,
}: DeleteAlertDialogProps) {
  const [typed, setTyped] = useState("");

  const handleClose = () => {
    setTyped("");
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="max-w-[420px] gap-3">
        <DialogHeader>
          <DialogTitle className="text-[13px] font-semibold">Delete alert</DialogTitle>
          <DialogDescription className="text-[12px]">
            Permanently delete <span className="font-medium text-foreground">{alertName}</span>?
            Evaluation and notifications stop immediately, and its recorded state is removed. This
            cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <p className="text-[12px] text-muted-foreground">
          Type <span className="font-medium text-foreground">{alertName}</span> to confirm.
        </p>
        <Input
          className="h-8 text-[12px]"
          placeholder={alertName}
          aria-label="confirm alert name"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoFocus
        />

        {error && <p className="text-[12px] text-destructive">{error.message}</p>}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-[12px]"
            onClick={handleClose}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            className="h-7 text-[12px]"
            disabled={typed !== alertName || isDeleting}
            onClick={onConfirm}
          >
            {isDeleting ? "Deleting..." : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

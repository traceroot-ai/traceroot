"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface DeleteLoopDialogProps {
  loopName: string;
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  isDeleting?: boolean;
  error?: Error | null;
}

export function DeleteLoopDialog({
  loopName,
  isOpen,
  onClose,
  onConfirm,
  isDeleting,
  error,
}: DeleteLoopDialogProps) {
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
          <DialogTitle>Delete Loop</DialogTitle>
        </DialogHeader>
        <div className="mt-1 space-y-4">
          <p className="text-[12px] text-muted-foreground">
            This removes the Loop, its runs and its memory. Signals it created stay. This action
            cannot be undone. Type <span className="font-medium text-foreground">{loopName}</span>{" "}
            to confirm.
          </p>
          <Input
            className="h-8 text-[12px]"
            placeholder={loopName}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoFocus
          />
          {error && <p className="text-[12px] text-destructive">{error.message}</p>}
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
              disabled={typed !== loopName || isDeleting}
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

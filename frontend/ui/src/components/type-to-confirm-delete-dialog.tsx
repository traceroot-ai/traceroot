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

interface TypeToConfirmDeleteDialogProps {
  /** "Delete loop". */
  title: string;
  /** What deleting removes and keeps, read before "This action cannot be undone." */
  consequence: string;
  /** The name to type; Delete stays disabled until it matches. */
  name: string;
  /** The confirm field's accessible name, e.g. "confirm loop name". */
  inputLabel: string;
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  isDeleting?: boolean;
  error?: Error | null;
}

/** A delete that asks for the item's name first; closing clears what was typed. */
export function TypeToConfirmDeleteDialog({
  title,
  consequence,
  name,
  inputLabel,
  isOpen,
  onClose,
  onConfirm,
  isDeleting,
  error,
}: TypeToConfirmDeleteDialogProps) {
  const [typed, setTyped] = useState("");

  const handleClose = () => {
    setTyped("");
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="mt-1 space-y-4">
          <DialogDescription className="text-[12px] text-muted-foreground">
            {consequence} This action cannot be undone. Type{" "}
            <span className="font-medium text-foreground">{name}</span> to confirm.
          </DialogDescription>
          <Input
            className="h-8 text-[12px]"
            placeholder={name}
            aria-label={inputLabel}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoFocus
          />
          {error && <p className="text-[12px] text-destructive">{error.message}</p>}
        </div>
        <DialogFooter>
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
            disabled={typed !== name || isDeleting}
            onClick={onConfirm}
          >
            {isDeleting ? "Deleting..." : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

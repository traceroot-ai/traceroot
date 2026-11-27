"use client";

import { TypeToConfirmDeleteDialog } from "@/components/type-to-confirm-delete-dialog";

interface DeleteLoopDialogProps {
  loopName: string;
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  isDeleting?: boolean;
  error?: Error | null;
}

/** The list's and the Loop page's delete: what goes, what stays, and the name to type. */
export function DeleteLoopDialog({ loopName, ...props }: DeleteLoopDialogProps) {
  return (
    <TypeToConfirmDeleteDialog
      title="Delete loop"
      consequence="This removes the loop and its runs. Signals it created and the memory notes it wrote stay."
      name={loopName}
      inputLabel="confirm loop name"
      {...props}
    />
  );
}

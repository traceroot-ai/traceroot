"use client";

import * as React from "react";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * The row actions menu — the exact three-dot dropdown the detectors table uses
 * (Popover + MoreHorizontal trigger, Edit / Delete items), so it reads as one
 * product.
 */
export function DatasetActionsMenu({
  onEdit,
  onDelete,
}: {
  /** Omit to render a delete-only menu (e.g. experiment runs, which aren't edited). */
  onEdit?: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-5 w-6 p-0 text-muted-foreground hover:text-foreground"
          onClick={(e) => e.stopPropagation()}
          aria-label="Row actions"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-36 p-1">
        {onEdit && (
          <button
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-[12px] hover:bg-muted/60"
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
              setOpen(false);
            }}
          >
            <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
            Edit
          </button>
        )}
        <button
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-[12px] text-destructive hover:bg-destructive/10"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
            setOpen(false);
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete
        </button>
      </PopoverContent>
    </Popover>
  );
}

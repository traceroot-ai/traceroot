"use client";

import { useState } from "react";
import Link from "next/link";
import { MoreHorizontal, Pause, Pencil, Play, Trash2 } from "lucide-react";
import { DOMAIN_ICONS } from "@/components/icons/domain-icons";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { Loop } from "../hooks/use-loops";
import { loopSignalsHref } from "../signals-href";

const SignalIcon = DOMAIN_ICONS.signal;

const ACTION_ITEM = "flex h-8 w-full items-center gap-2 rounded-[2px] px-2 text-[13px]";

interface LoopActionsMenuProps {
  projectId: string;
  loop: Pick<Loop, "id" | "name" | "status">;
  onToggleStatus: () => void;
  onDelete: () => void;
  isStatusPending: boolean;
  /** Edit returns to the Loop's page instead of the list. */
  fromDetail?: boolean;
}

/** Pause or resume, Edit, View signals and Delete. Clicks stay out of a clickable table row. */
export function LoopActionsMenu({
  projectId,
  loop,
  onToggleStatus,
  onDelete,
  isStatusPending,
  fromDetail,
}: LoopActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const stopped = loop.status !== "active";
  const select = (e: React.MouseEvent, action?: () => void) => {
    e.stopPropagation();
    action?.();
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
          aria-label={`Actions for ${loop.name}`}
          onClick={(e) => e.stopPropagation()}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      {/* The menu renders in a portal, but React still bubbles its clicks to the row. */}
      <PopoverContent align="end" className="w-36 p-1" onClick={(e) => e.stopPropagation()}>
        <button
          className={cn(ACTION_ITEM, "hover:bg-muted disabled:opacity-50")}
          disabled={isStatusPending}
          onClick={(e) => select(e, onToggleStatus)}
        >
          {stopped ? (
            <Play className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <Pause className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          {stopped ? "Resume" : "Pause"}
        </button>
        <Link
          href={`/projects/${projectId}/loops/${loop.id}/edit${fromDetail ? "?from=detail" : ""}`}
          className={cn(ACTION_ITEM, "hover:bg-muted")}
          onClick={(e) => select(e)}
        >
          <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
          Edit
        </Link>
        <Link
          href={loopSignalsHref(projectId, loop.name)}
          className={cn(ACTION_ITEM, "hover:bg-muted")}
          onClick={(e) => select(e)}
        >
          <SignalIcon className="h-3.5 w-3.5 text-muted-foreground" />
          View signals
        </Link>
        <button
          className={cn(ACTION_ITEM, "text-destructive hover:bg-destructive/10")}
          onClick={(e) => select(e, onDelete)}
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete
        </button>
      </PopoverContent>
    </Popover>
  );
}

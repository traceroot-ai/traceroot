"use client";

/**
 * The row's metadata map as one truncated line, revealed in full on hover or keyboard. A
 * popover rather than a `title` or tooltip because the reveal is a scrollable JSON document
 * and has to be keyboard-reachable.
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MetadataJson } from "./MetadataJson";
import { cn } from "@/lib/utils";
import { formatContentPreview } from "../utils";
import { stringifyMetadataEntries, type MetadataEntry } from "../utils/metadata";

/** The surface sits clear of the trigger; this grace period covers the pointer crossing. */
const HOVER_CLOSE_DELAY_MS = 120;

const PREVIEW_TEXT = "block truncate font-mono text-[11px] text-muted-foreground";

interface TraceMetadataCellProps {
  entries: readonly MetadataEntry[];
  borderClassName: string | false;
}

export function TraceMetadataCell({ entries, borderClassName }: TraceMetadataCellProps) {
  const [isOpen, setIsOpen] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // How the open started: a hover must not pull focus away, but a keyboard open must move
  // focus into the surface or its scrolling and its Escape are unreachable.
  const isOpenedByPointerRef = useRef(false);

  const cancelScheduledClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    cancelScheduledClose();
    closeTimerRef.current = setTimeout(() => setIsOpen(false), HOVER_CLOSE_DELAY_MS);
  }, [cancelScheduledClose]);

  const openByPointer = useCallback(() => {
    cancelScheduledClose();
    isOpenedByPointerRef.current = true;
    setIsOpen(true);
  }, [cancelScheduledClose]);

  // A row can unmount mid-hover when the list refetches; a pending close must not outlive it.
  useEffect(() => cancelScheduledClose, [cancelScheduledClose]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      // A queued hover-close would otherwise fire after a later reopen and shut it again.
      cancelScheduledClose();
      setIsOpen(nextOpen);
    },
    [cancelScheduledClose],
  );

  const handleTriggerClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      // The row itself opens the trace, so revealing metadata must not also select the row.
      event.stopPropagation();
      // Enter and Space arrive as a click with no originating pointer.
      const isKeyboardActivation = event.detail === 0;
      // Radix toggles the trigger, so a click on a hover-opened surface would close it.
      if (isOpen) {
        event.preventDefault();
        if (isKeyboardActivation) contentRef.current?.focus();
        return;
      }
      isOpenedByPointerRef.current = !isKeyboardActivation;
    },
    [isOpen],
  );

  const cellClassName = cn("max-w-[180px]", borderClassName, "px-3 py-1.5");

  if (entries.length === 0) {
    return (
      <td className={cellClassName}>
        <span className={PREVIEW_TEXT}>{formatContentPreview(null)}</span>
      </td>
    );
  }

  // The preview line reads from the same serialization the popover documents.
  const payload = stringifyMetadataEntries(entries);

  return (
    <td className={cellClassName}>
      <Popover open={isOpen} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            onPointerEnter={openByPointer}
            onPointerLeave={scheduleClose}
            onFocus={cancelScheduledClose}
            onClick={handleTriggerClick}
            className={cn(
              PREVIEW_TEXT,
              "w-full text-left transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            )}
          >
            {formatContentPreview(payload)}
          </button>
        </PopoverTrigger>
        <PopoverContent
          ref={contentRef}
          align="start"
          aria-label="Metadata"
          // Portaled and fixed, so it cannot widen the table; these keep it in the viewport.
          collisionPadding={8}
          className="w-[22rem] max-w-[calc(100vw-2rem)] p-0"
          onOpenAutoFocus={(event) => {
            if (isOpenedByPointerRef.current) event.preventDefault();
          }}
          onPointerEnter={cancelScheduledClose}
          onPointerLeave={scheduleClose}
          onClick={(event) => {
            // React events bubble the component tree, so a portaled click still reaches the row.
            event.stopPropagation();
          }}
        >
          {/* No title bar: the braces already say what this is, and a header would put a
              label above a document that reads as one thing. */}
          <div className="max-h-64 overflow-auto px-3 py-2">
            <MetadataJson entries={entries} />
          </div>
        </PopoverContent>
      </Popover>
    </td>
  );
}

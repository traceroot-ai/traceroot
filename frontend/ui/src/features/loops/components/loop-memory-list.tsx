"use client";

import { formatRelativeTime } from "@/lib/utils";
import type { LoopMemoryDto } from "@traceroot/core/loops/pure";

interface LoopMemoryListProps {
  /** The Loop whose page this is; a note's writer is shown relative to it. */
  loopId: string;
  notes: LoopMemoryDto[];
}

function scope(note: LoopMemoryDto, loopId: string): string {
  if (note.loopId === null) return "Shared by all Loops";
  return note.loopId === loopId ? "Written by this Loop" : "Written by another Loop";
}

/** "Expires in 3 days" for a note with an expiry still ahead, "No expiry" otherwise. */
function expiry(note: LoopMemoryDto): string {
  if (!note.expiresAt) return "No expiry";
  const days = Math.ceil((Date.parse(note.expiresAt) - Date.now()) / 86_400_000);
  if (days <= 0) return "Expires soon";
  return `Expires in ${days} ${days === 1 ? "day" : "days"}`;
}

/** What the project's Loops remember between runs: short notes by topic, shared across the project. */
export function LoopMemoryList({ loopId, notes }: LoopMemoryListProps) {
  if (notes.length === 0) {
    return (
      <div className="flex h-48 flex-col items-center justify-center gap-1.5 px-4 text-center">
        <p className="text-[13px] text-muted-foreground">No memory yet</p>
        <p className="max-w-md text-[12px] text-muted-foreground">
          A Loop keeps short notes here between runs, so it does not report the same thing twice.
        </p>
      </div>
    );
  }
  return (
    <ul className="divide-y divide-border">
      {notes.map((note) => (
        <li key={note.id} className="px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-mono text-[12px] font-medium text-foreground">{note.key}</span>
            <span className="rounded-[2px] bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
              {scope(note, loopId)}
            </span>
            <span className="text-[11px] text-muted-foreground">{expiry(note)}</span>
            <span className="ml-auto text-[11px] text-muted-foreground">
              Updated {formatRelativeTime(note.updateTime)}
            </span>
          </div>
          <p className="mt-1.5 whitespace-pre-wrap text-[12px] leading-relaxed text-muted-foreground">
            {note.content}
          </p>
        </li>
      ))}
    </ul>
  );
}

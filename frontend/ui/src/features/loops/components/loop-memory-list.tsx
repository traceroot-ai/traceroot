"use client";

import { Badge } from "@/components/ui/badge";
import { formatRelativeTime } from "@/lib/utils";
import type { LoopMemoryDto } from "@traceroot/core/loops/pure";

interface LoopMemoryListProps {
  notes: LoopMemoryDto[];
}

/** The loop that last wrote the note; with no writer recorded, that loop was deleted. */
function writer(note: LoopMemoryDto): string {
  return note.loopName === null ? "Written by a deleted loop" : `Written by ${note.loopName}`;
}

/** "Expires in 3 days" for a note with an expiry still ahead, "No expiry" otherwise. */
function expiry(note: LoopMemoryDto): string {
  if (!note.expiresAt) return "No expiry";
  const days = Math.ceil((Date.parse(note.expiresAt) - Date.now()) / 86_400_000);
  if (days <= 0) return "Expires soon";
  return `Expires in ${days} ${days === 1 ? "day" : "days"}`;
}

/** What the project's loops remember between runs: short notes by topic, shared across the project. */
export function LoopMemoryList({ notes }: LoopMemoryListProps) {
  if (notes.length === 0) {
    return (
      <div className="flex h-32 flex-col items-center justify-center gap-1.5 px-4 text-center">
        <p className="text-[13px] text-muted-foreground">No memory yet</p>
        <p className="max-w-md text-[12px] text-muted-foreground">
          A loop keeps short notes here between runs, so it does not report the same thing twice.
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
            <Badge>{writer(note)}</Badge>
            <span className="text-[12px] text-muted-foreground">{expiry(note)}</span>
            <span className="ml-auto text-[12px] text-muted-foreground">
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

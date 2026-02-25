"use client";

import { useState } from "react";
import { MessageSquare, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AISession } from "../types";

interface SessionHistoryProps {
  sessions: AISession[];
  currentSessionId: string | null;
  projectId: string;
  onSelect: (session: AISession) => void;
  onDelete: (sessionId: string) => void;
}

function getTimeGroup(dateStr: string): string {
  const now = new Date();
  const date = new Date(dateStr);
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  const weeks = Math.floor(diffDays / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(diffDays / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
}

export function SessionHistory({
  sessions,
  currentSessionId,
  projectId,
  onSelect,
  onDelete,
}: SessionHistoryProps) {
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleDelete = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    setDeletingId(sessionId);
    try {
      const res = await fetch(`/api/projects/${projectId}/ai/sessions/${sessionId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        onDelete(sessionId);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setDeletingId(null);
    }
  };

  if (sessions.length === 0) {
    return (
      <div className="px-2.5 py-3 text-center text-[12px] text-muted-foreground">
        No past sessions
      </div>
    );
  }

  // Group sessions by time
  const groups: { label: string; sessions: AISession[] }[] = [];
  let currentGroup: string | null = null;

  for (const session of sessions) {
    const group = getTimeGroup(session.createTime);
    if (group !== currentGroup) {
      currentGroup = group;
      groups.push({ label: group, sessions: [] });
    }
    groups[groups.length - 1].sessions.push(session);
  }

  return (
    <div className="max-h-[400px] overflow-y-auto">
      {groups.map((group) => (
        <div key={group.label}>
          <div className="px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground">
            {group.label}
          </div>
          {group.sessions.map((s) => (
            <button
              key={s.id}
              className={cn(
                "group flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-muted/50",
                s.id === currentSessionId && "bg-muted",
              )}
              onClick={() => onSelect(s)}
              disabled={deletingId === s.id}
            >
              <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-[12px]">
                {s.title || "Untitled session"}
              </span>
              <Trash2
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                onClick={(e) => handleDelete(e, s.id)}
              />
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

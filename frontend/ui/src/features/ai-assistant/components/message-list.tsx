"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import type { AIMessage } from "../types";

interface MessageListProps {
  messages: AIMessage[];
}

export function MessageList({ messages }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <div className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
      {messages.length === 0 && <div />}
      {messages.map((msg) => (
        <div
          key={msg.id}
          className={cn("flex", msg.role === "user" ? "justify-end" : "justify-start")}
        >
          <div
            className={cn(
              "max-w-[85%] whitespace-pre-wrap rounded-md px-3 py-1.5 text-[13px]",
              msg.role === "user"
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-foreground",
            )}
          >
            {msg.content}
            {msg.isStreaming && (
              <span className="ml-1 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-current" />
            )}
          </div>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

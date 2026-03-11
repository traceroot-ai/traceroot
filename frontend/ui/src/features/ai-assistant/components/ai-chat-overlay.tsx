"use client";

import { X, Plus, History, Square } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MessageList } from "./message-list";
import { MessageInput } from "./message-input";
import { SessionHistory } from "./session-history";
import { useAiChat } from "../hooks/use-ai-chat";
import { getProject } from "@/lib/api";

interface AiChatOverlayProps {
  projectId: string;
  traceId?: string;
  onClose: () => void;
}

/**
 * AI chat panel for use inside trace detail viewer.
 * traceId is passed through to the agent so it knows which trace the user is viewing.
 */
const MIN_WIDTH = 280;
const MAX_WIDTH = 900;
const DEFAULT_WIDTH = 400;

export function AiChatOverlay({ projectId, traceId, onClose }: AiChatOverlayProps) {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      dragging.current = true;
      startX.current = e.clientX;
      startWidth.current = width;
      e.preventDefault();

      const onMouseMove = (e: MouseEvent) => {
        if (!dragging.current) return;
        const delta = startX.current - e.clientX;
        setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth.current + delta)));
      };
      const onMouseUp = () => {
        dragging.current = false;
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
      };
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    [width],
  );

  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => getProject(projectId),
    enabled: !!projectId,
  });
  const workspaceId = project?.workspace_id;

  const {
    messages,
    isStreaming,
    sessions,
    historyOpen,
    currentSessionId,
    setHistoryOpen,
    handleSend,
    handleAbort,
    handleNewSession,
    handleOpenHistory,
    handleSelectSession,
    handleDeleteSession,
  } = useAiChat({ projectId, traceId });

  return (
    <div className="relative flex h-full flex-col border-l bg-background" style={{ width }}>
      {/* Left resize handle */}
      <div
        className="absolute left-0 top-0 h-full w-1 cursor-col-resize hover:bg-primary/30 active:bg-primary/50"
        onMouseDown={onMouseDown}
      />
      {/* Header */}
      <div className="flex h-10 items-center gap-1 border-b bg-muted/30 px-3">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          title="New session"
          onClick={handleNewSession}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
        <Popover open={historyOpen} onOpenChange={setHistoryOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              title="History"
              onClick={handleOpenHistory}
            >
              <History className="h-3.5 w-3.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent side="bottom" align="start" className="w-[300px] p-1" sideOffset={4}>
            <SessionHistory
              sessions={sessions}
              currentSessionId={currentSessionId}
              projectId={projectId}
              onSelect={handleSelectSession}
              onDelete={handleDeleteSession}
            />
          </PopoverContent>
        </Popover>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <MessageList messages={messages} sessionStreaming={isStreaming} />
      <MessageInput
        onSend={handleSend}
        workspaceId={workspaceId}
        actions={
          isStreaming && (
            <button
              onClick={handleAbort}
              className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
              title="Stop generation"
            >
              <Square className="h-3 w-3 fill-current" />
              Stop
            </button>
          )
        }
      />
    </div>
  );
}

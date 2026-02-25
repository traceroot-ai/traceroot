"use client";

import { useParams } from "next/navigation";
import { X, Plus, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MessageList } from "./message-list";
import { MessageInput } from "./message-input";
import { SessionHistory } from "./session-history";
import { useAiChat } from "../hooks/use-ai-chat";

interface AiAssistantPanelProps {
  open: boolean;
  onClose: () => void;
}

export function AiAssistantPanel({ open, onClose }: AiAssistantPanelProps) {
  const params = useParams();
  const projectId = params?.projectId as string | undefined;

  const {
    messages,
    isStreaming,
    sessions,
    historyOpen,
    currentSessionId,
    setHistoryOpen,
    handleSend,
    handleNewSession,
    handleOpenHistory,
    handleSelectSession,
    handleDeleteSession,
  } = useAiChat({ projectId });

  if (!open) return null;

  return (
    <div className="flex h-screen w-[400px] shrink-0 flex-col border-l bg-background">
      {/* Header */}
      <div className="flex h-14 items-center gap-1 border-b px-3">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          title="New session"
          onClick={handleNewSession}
        >
          <Plus className="h-4 w-4" />
        </Button>
        <Popover open={historyOpen} onOpenChange={setHistoryOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              title="History"
              onClick={handleOpenHistory}
            >
              <History className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent side="bottom" align="start" className="w-[300px] p-1" sideOffset={4}>
            <SessionHistory
              sessions={sessions}
              currentSessionId={currentSessionId}
              projectId={projectId || ""}
              onSelect={handleSelectSession}
              onDelete={handleDeleteSession}
            />
          </PopoverContent>
        </Popover>
        <div className="flex-1" />
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Messages */}
      <MessageList messages={messages} />

      {/* Input */}
      <MessageInput onSend={handleSend} disabled={isStreaming} />
    </div>
  );
}

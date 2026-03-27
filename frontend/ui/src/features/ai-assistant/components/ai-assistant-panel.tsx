"use client";

import { useParams } from "next/navigation";
import { X, Plus, History, Square, AlertTriangle } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MessageList } from "./message-list";
import { MessageInput } from "./message-input";
import { SessionHistory } from "./session-history";
import { useAiChat } from "../hooks/use-ai-chat";
import { usePanelResize } from "../hooks/use-panel-resize";
import { getProject, getAvailableLLMModels } from "@/lib/api";

interface AiAssistantPanelProps {
  open: boolean;
  onClose: () => void;
}

export function AiAssistantPanel({ open, onClose }: AiAssistantPanelProps) {
  const { width, onMouseDown } = usePanelResize();
  const params = useParams();
  const projectId = params.projectId as string;

  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => getProject(projectId),
    enabled: !!projectId,
  });

  // workspaceId derived from project (always available in project context)
  const workspaceId = project?.workspace_id || "";

  // Check if any models are available (system or BYOK)
  const { data: llmModels } = useQuery({
    queryKey: ["llm-models", workspaceId],
    queryFn: () => getAvailableLLMModels(workspaceId!),
    enabled: !!workspaceId,
  });
  const hasModels =
    !llmModels ||
    llmModels.systemModels.some((g) => g.models.length > 0) ||
    llmModels.byokProviders.some((g) => g.models.length > 0);

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
  } = useAiChat({ projectId });

  if (!open) return null;

  return (
    <div
      className="relative flex h-screen shrink-0 flex-col border-l bg-background"
      style={{ width }}
    >
      {/* Left resize handle */}
      <div
        className="absolute left-0 top-0 h-full w-1 cursor-col-resize hover:bg-primary/30 active:bg-primary/50"
        onMouseDown={onMouseDown}
      />
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
      {!projectId ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-[13px] text-muted-foreground">
          Open a project to start using the AI assistant.
        </div>
      ) : !hasModels ? (
        <div className="flex flex-1 items-center justify-center px-6">
          <div className="flex max-w-[280px] flex-col items-center gap-3 text-center">
            <AlertTriangle className="h-8 w-8 text-yellow-500" />
            <p className="text-[13px] font-medium">No LLM models available</p>
            <p className="text-[12px] text-muted-foreground">
              To use the AI assistant, configure a system API key (e.g. Anthropic, OpenAI) in your
              environment, or add a BYOK provider in{" "}
              <span className="font-medium text-foreground">
                Workspace Settings &rarr; Model Providers
              </span>
              .
            </p>
          </div>
        </div>
      ) : (
        <MessageList messages={messages} sessionStreaming={isStreaming} />
      )}

      {/* Input */}
      <MessageInput
        onSend={handleSend}
        disabled={!projectId || !hasModels}
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

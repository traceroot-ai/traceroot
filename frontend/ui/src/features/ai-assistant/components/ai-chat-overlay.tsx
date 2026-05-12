"use client";

import { X, Plus, History, Square, AlertTriangle } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MessageList } from "./message-list";
import { MessageInput } from "./message-input";
import { SessionHistory } from "./session-history";
import { useAiChat } from "../hooks/use-ai-chat";
import { getProject, getAvailableLLMModels } from "@/lib/api";

interface AiChatOverlayProps {
  projectId: string;
  traceId?: string;
  traceSessionId?: string;
  onClose: () => void;
}

/**
 * AI chat panel for use inside trace detail viewer.
 * traceId is passed through to the agent so it knows which trace the user is viewing.
 */
export function AiChatOverlay({ projectId, traceId, traceSessionId, onClose }: AiChatOverlayProps) {
  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => getProject(projectId),
    enabled: !!projectId,
  });
  const workspaceId = project?.workspace_id;

  const { data: llmModels } = useQuery({
    queryKey: ["llm-models", workspaceId],
    queryFn: () => getAvailableLLMModels(workspaceId!),
    enabled: !!workspaceId,
  });

  const unsupportedModels = llmModels
    ? llmModels.byokProviders.flatMap((g) =>
        g.models.filter((m) => !m.supported).map((m) => ({ id: m.id, provider: g.provider })),
      )
    : [];

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
  } = useAiChat({ projectId, traceId, traceSessionId });

  return (
    <div className="flex h-full flex-col border-l border-border bg-background">
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

      {/* Unsupported model warning */}
      {unsupportedModels.length > 0 && (
        <div className="mx-3 mt-2 flex items-start gap-2 rounded-md border border-yellow-200 bg-yellow-50 px-3 py-2 text-[12px] dark:border-yellow-900 dark:bg-yellow-950">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-600" />
          <div>
            <p className="font-medium text-yellow-800 dark:text-yellow-200">
              Unsupported model{unsupportedModels.length > 1 ? "s" : ""} detected
            </p>
            <p className="mt-0.5 text-yellow-700 dark:text-yellow-300">
              {unsupportedModels.map((m) => m.id).join(", ")}{" "}
              {unsupportedModels.length > 1 ? "are" : "is"} no longer in the supported model list.
              Update in{" "}
              <a
                href={`/workspaces/${workspaceId}/settings/model-providers`}
                className="font-medium underline"
              >
                Settings &rarr; Model Providers
              </a>
              .
            </p>
          </div>
        </div>
      )}

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

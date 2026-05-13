"use client";

import { useEffect } from "react";
import { X, Plus, History, Square, AlertTriangle } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MessageList } from "./message-list";
import { MessageInput } from "./message-input";
import { SessionHistory } from "./session-history";
import { useAiChat } from "../hooks/use-ai-chat";
import { getProject, getAvailableLLMModels } from "@/lib/api";
import type { AiTraceContext } from "../types";

interface AiAssistantPanelProps {
  projectId?: string;
  onClose: () => void;
  initialContext?: AiTraceContext | null;
}

export function AiAssistantPanel({ projectId, onClose, initialContext }: AiAssistantPanelProps) {
  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => getProject(projectId!),
    enabled: !!projectId,
  });

  // workspaceId from project (only available on project pages)
  const workspaceId = project?.workspace_id;

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
  } = useAiChat({
    projectId,
    traceId: initialContext?.traceId,
    traceSessionId: initialContext?.traceSessionId,
  });

  // Reset to a blank session whenever the panel is closed so re-opening starts fresh.
  useEffect(() => () => handleNewSession(), []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex h-full flex-col border-l border-border bg-background">
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
          <PopoverContent
            side="bottom"
            align="start"
            className="z-[70] w-[300px] p-1"
            sideOffset={4}
          >
            <SessionHistory
              sessions={sessions}
              currentSessionId={currentSessionId}
              projectId={projectId ?? ""}
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

      {/* Messages */}
      {!hasModels ? (
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

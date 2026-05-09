"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X, Plus, History, Square, AlertTriangle } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useLayout } from "@/components/layout/app-layout";
import { MessageList } from "./message-list";
import { MessageInput } from "./message-input";
import { SessionHistory } from "./session-history";
import { useAiChat } from "../hooks/use-ai-chat";
import { usePanelResize } from "../hooks/use-panel-resize";
import { getProject, getAvailableLLMModels } from "@/lib/api";
import type { AiTraceContext } from "../types";

interface AiAssistantPanelProps {
  projectId?: string;
  open: boolean;
  onClose: () => void;
  initialContext?: AiTraceContext | null;
}

export function AiAssistantPanel({
  projectId,
  open,
  onClose,
  initialContext,
}: AiAssistantPanelProps) {
  const { width, onMouseDown } = usePanelResize();
  const { aiPanelSlotEl } = useLayout();
  const inSlot = !!aiPanelSlotEl;

  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => getProject(projectId!),
    enabled: open && !!projectId,
  });

  // workspaceId from project (only available on project pages)
  const workspaceId = project?.workspace_id;

  // Check if any models are available (system or BYOK)
  const { data: llmModels } = useQuery({
    queryKey: ["llm-models", workspaceId],
    queryFn: () => getAvailableLLMModels(workspaceId!),
    enabled: open && !!workspaceId,
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
    handleClose,
    handleOpenHistory,
    handleSelectSession,
    handleDeleteSession,
  } = useAiChat({
    projectId,
    traceId: initialContext?.traceId,
    traceSessionId: initialContext?.traceSessionId,
  });

  // End the conversation when the panel closes (X button, sidebar toggle, or
  // route change). Any in-flight run is aborted client-side; the agent
  // service finishes writing its message to DB on its own, so users can
  // recover the full message via History. Reopening starts a fresh session.
  // Switching traces within the same page does NOT close the panel, so this
  // does not fire there — preserving the in-page chat-survives-trace-switch
  // behavior from the decoupling fix.
  useEffect(() => {
    if (!open) handleClose();
  }, [open, handleClose]);

  // Stay mounted when closed: hide via CSS so trace switches (which keep the
  // panel open) do not tear down the conversation. Closing the panel itself
  // ends the conversation via the effect above — DOM stays mounted but state
  // is reset, so re-opening starts fresh.
  const panelInner = (
    <>
      {/* Left resize handle */}
      <div
        className="absolute left-0 top-0 h-full w-1 cursor-col-resize hover:bg-primary/30 active:bg-primary/50"
        onMouseDown={onMouseDown}
      />
      {/* Header */}
      <div
        className={cn(
          "flex items-center gap-1 border-b px-3",
          inSlot ? "h-10 bg-muted/30" : "h-14",
        )}
      >
        <Button
          variant="ghost"
          size="icon"
          className={cn("shrink-0", inSlot ? "h-7 w-7 p-0" : "h-8 w-8")}
          title="New session"
          onClick={handleNewSession}
        >
          <Plus className={inSlot ? "h-3.5 w-3.5" : "h-4 w-4"} />
        </Button>
        <Popover open={historyOpen} onOpenChange={setHistoryOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={cn("shrink-0", inSlot ? "h-7 w-7 p-0" : "h-8 w-8")}
              title="History"
              onClick={handleOpenHistory}
            >
              <History className={inSlot ? "h-3.5 w-3.5" : "h-4 w-4"} />
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
        <Button
          variant="ghost"
          size="icon"
          className={cn("shrink-0", inSlot ? "h-7 w-7 p-0" : "h-8 w-8")}
          onClick={onClose}
        >
          <X className={inSlot ? "h-3.5 w-3.5" : "h-4 w-4"} />
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
    </>
  );

  // Portal into a host-registered slot when present; otherwise render in
  // place at the AppLayout flex root. State lives in AppLayout so chat
  // survives host mount/unmount.
  if (aiPanelSlotEl) {
    return createPortal(
      <div
        className={cn(
          "relative flex h-full shrink-0 flex-col border-l bg-background",
          !open && "hidden",
        )}
        style={{ width: open ? width : 0 }}
      >
        {panelInner}
      </div>,
      aiPanelSlotEl,
    );
  }

  return (
    <div
      className={cn(
        "relative z-[60] flex h-screen shrink-0 flex-col border-l bg-background",
        !open && "hidden",
      )}
      style={{ width: open ? width : 0 }}
    >
      {panelInner}
    </div>
  );
}

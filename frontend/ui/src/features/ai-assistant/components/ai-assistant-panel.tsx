"use client";

import type { ReactNode } from "react";
import { X, Plus, History, Square, AlertTriangle } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MessageList } from "./message-list";
import { MessageInput } from "./message-input";
import { PendingDecisionBar } from "./pending-decision-bar";
import { SessionHistory } from "./session-history";
import { useAiChatContext } from "./ai-chat-context";
import { getProject, getAvailableLLMModels } from "@/lib/api";
import { useRetention } from "@/lib/hooks/use-retention";

interface AiAssistantPanelProps {
  projectId?: string;
  onClose: () => void;
  /**
   * Compact chrome mode (smaller header / buttons / icons) for use inside the
   * trace or session viewer where vertical space is tighter. Mirrors upstream's
   * pre-decoupling `AiChatOverlay` styling. Default (false) matches the
   * project-wide right rail used in AppLayout.
   */
  compact?: boolean;
  /**
   * Placement variant. `rail` (default) is the side-panel chrome used by the
   * right rail and the viewer panels: left border, Close button. `page` is the
   * full-page Home placement: full-width header with the content below it
   * centered in a max-width column, and no Close button (the page owns the
   * panel; there is nothing to close). Everything else — header controls,
   * model gate, messages, input — is identical.
   */
  variant?: "rail" | "page";
  /**
   * Optional content rendered vertically centered in the message region while
   * the conversation is empty, models are available, and no send is in flight
   * (once streaming starts the message list takes over so its waiting UI
   * shows). The host page owns the content; the panel owns the placement, so
   * the greeting sits between the header and the input instead of above the
   * whole panel.
   */
  emptyState?: ReactNode;
}

/**
 * Pure presentational AI chatbox UI.
 *
 * State lives in {@link AiChatProvider} (at AppLayout root) and is consumed
 * via {@link useAiChatContext}. This component is mounted by whichever host
 * currently owns the AI slot — AppLayout's right rail when there is no
 * trace/session viewer open, otherwise the viewer's own ResizablePanel. The
 * provider above survives all of these mount/unmount cycles, so chat history
 * and stream state persist across host transitions (#784 decoupling).
 */
export function AiAssistantPanel({
  projectId,
  onClose,
  compact = false,
  variant = "rail",
  emptyState,
}: AiAssistantPanelProps) {
  // In page placement the root spans the full page so the header's bottom
  // border runs edge to edge like every other section header; only the
  // content below it (messages, empty state, input) is centered in the
  // max-width column.
  const rootCls =
    variant === "page"
      ? "flex h-full w-full flex-col bg-background"
      : "flex h-full flex-col border-l border-border bg-background";
  // The page header is a slim toolbar, the same height as a sidebar nav row
  // (py-2 + 13px text = 36px), since the page already has the app header
  // above it; the rail keeps its taller chrome.
  const headerCls = compact
    ? "flex h-10 items-center gap-1 border-b bg-muted/30 px-3"
    : variant === "page"
      ? "flex h-9 items-center gap-1 border-b px-3"
      : "flex h-14 items-center gap-1 border-b px-3";
  const btnCls = compact ? "h-7 w-7 shrink-0 p-0" : "h-8 w-8 shrink-0";
  const iconCls = compact ? "h-3.5 w-3.5" : "h-4 w-4";
  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => getProject(projectId!),
    enabled: !!projectId,
  });

  // workspaceId from project (only available on project pages)
  const workspaceId = project?.workspace_id;

  // The plan's retention window, passed to the transcript so a range left in
  // storage by a workspace that has since downgraded is neither charted nor
  // labeled on a card. (It reuses the project query above; with no project
  // there is no plan to look up, and nothing is clamped.)
  const { retentionDays } = useRetention(projectId ?? "");

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
    modelSelection,
    hasPendingDecision,
    pendingDecision,
    setHistoryOpen,
    setModelSelection,
    handleSend,
    handleDecision,
    handleAbort,
    handleNewSession,
    handleClose,
    handleOpenHistory,
    handleSelectSession,
    handleDeleteSession,
  } = useAiChatContext();

  // Clicking X explicitly ends the conversation: abort any in-flight stream,
  // clear messages, drop the session id. Matches the upstream pre-decoupling
  // behavior (AiChatOverlay's `handleClose`). Trace switching does not go
  // through this path — the panel stays mounted across `↑/↓`, so chat history
  // survives those navigations (#784).
  const handleCloseClick = () => {
    handleClose();
    onClose();
  };

  return (
    <div className={rootCls}>
      {/* Header */}
      <div className={headerCls}>
        <Button
          variant="ghost"
          size="icon"
          className={btnCls}
          title="New session"
          onClick={handleNewSession}
        >
          <Plus className={iconCls} />
        </Button>
        <Popover open={historyOpen} onOpenChange={setHistoryOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={btnCls}
              title="History"
              onClick={handleOpenHistory}
            >
              <History className={iconCls} />
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
        {variant === "rail" && (
          <Button variant="ghost" size="icon" className={btnCls} onClick={handleCloseClick}>
            <X className={iconCls} />
          </Button>
        )}
      </div>

      {/* Everything below the header centers in the page column; in rail
          placement the wrapper spans the panel, so layout is unchanged. */}
      <div
        className={
          variant === "page"
            ? "mx-auto flex min-h-0 w-full max-w-[900px] flex-1 flex-col"
            : "flex min-h-0 flex-1 flex-col"
        }
      >
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
                <a
                  href={`/workspaces/${workspaceId}/settings/model-providers`}
                  className="font-medium underline"
                >
                  Workspace Settings &rarr; Model Providers
                </a>
                .
              </p>
            </div>
          </div>
        ) : messages.length === 0 && emptyState && !isStreaming ? (
          // m-auto (not items/justify-center) so that when the region is
          // shorter than the content, the top stays reachable by scrolling
          // instead of clipping outside the scroll container.
          <div className="flex flex-1 overflow-y-auto px-6">
            <div className="m-auto py-6">{emptyState}</div>
          </div>
        ) : (
          <MessageList
            messages={messages}
            sessionStreaming={isStreaming}
            projectId={projectId}
            retentionDays={projectId ? retentionDays : undefined}
          />
        )}

        {/* A parked proposal is decided here, at the composer, not on its
            card: create/skip are the reply. Keyed by the decision so a
            superseding proposal re-arms the buttons in place. */}
        {pendingDecision !== null && (
          <PendingDecisionBar
            key={pendingDecision.decisionId}
            decision={pendingDecision}
            onDecide={handleDecision}
          />
        )}

        {/* Input */}
        <MessageInput
          onSend={handleSend}
          modelSelection={modelSelection}
          onModelChange={setModelSelection}
          disabled={!projectId || !hasModels}
          workspaceId={workspaceId}
          // While a proposal awaits a decision, a typed reply revises it.
          placeholder={hasPendingDecision ? "Reply to revise" : undefined}
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
    </div>
  );
}

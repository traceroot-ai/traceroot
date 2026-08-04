"use client";

import { useEffect } from "react";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useLayout } from "@/components/layout/app-layout";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { AiAssistantPanel } from "@/features/ai-assistant/components/ai-assistant-panel";
import { useAiChatContext } from "@/features/ai-assistant/components/ai-chat-context";
import {
  flattenAvailableModels,
  pickDefaultModel,
} from "@/features/ai-assistant/lib/resolve-model";
import { getProject, getAvailableLLMModels } from "@/lib/api";

// Starter prompts shown while the current session has no messages. Clicking
// one sends it immediately through the same send path as the message input.
const STARTER_PROMPTS = [
  "Investigate the most recent errored trace",
  "Summarize today's sessions",
  "What did detector findings flag this week?",
];

/**
 * Home — the AI assistant as a first-class project section. Renders the same
 * assistant panel used by the right rail and viewer panels, as a centered
 * full-page column. Chat state lives in the app-wide AiChatProvider, so a
 * conversation started here survives navigating to other sections.
 */
export default function HomePage() {
  const params = useParams();
  const projectId = params.projectId as string;
  const { registerAiHost, aiContext, setAiContext, aiInitialSessionId } = useLayout();
  const { messages, handleSend } = useAiChatContext();

  // Claim the AI slot for this page so AppLayout's project rail can never
  // double-render the assistant alongside it. `registerAiHost()` returns its
  // own cleanup, which we return from the effect so React releases the slot
  // on unmount and the rail behaves normally elsewhere.
  useEffect(() => {
    return registerAiHost();
  }, [registerAiHost]);

  // Home is project-scoped but trace-agnostic: a trace context inherited from
  // a trace/session viewer would silently attribute new chats here to that
  // trace. AppLayout's navigation effect already clears the context (and any
  // session handoff id) on every pathname change, so in the integrated app
  // this mount-time clear is defense-in-depth for direct mounts and effect
  // ordering — not the primary mechanism, and no handoff-into-Home flow
  // exists today. Mount-only by design.
  useEffect(() => {
    if (!aiInitialSessionId && aiContext) setAiContext(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Starter prompts bypass the message input, so they resolve the model the
  // same way the input's selector would auto-pick it: from the settled model
  // list only (`isPending: false` keeps the compiled-in fallback list out, so
  // a prompt can never run against a model the workspace doesn't have). This is
  // the auto-pick default, not the selector's live state — the selector's
  // selection lives inside MessageInput and isn't readable from here.
  // These queries share keys with the panel's own, so react-query dedups them.
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
  const defaultModel = pickDefaultModel(flattenAvailableModels(llmModels, false));

  return (
    <div className="flex h-full flex-col text-[13px]">
      <ProjectBreadcrumb projectId={projectId} />
      {/* Suppressed during a session handoff so the greeting can't flash while
          the handed-off session's messages load. */}
      {messages.length === 0 && !aiInitialSessionId && (
        <div className="mx-auto w-full max-w-[900px] px-6 pb-2 pt-10 text-center">
          <h1 className="text-[15px] font-medium">How can I help?</h1>
          <p className="mt-1 text-[12px] text-muted-foreground">
            Ask about this project&apos;s traces, sessions, errors, and detector findings.
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {STARTER_PROMPTS.map((prompt) => (
              <button
                key={prompt}
                type="button"
                disabled={!defaultModel}
                onClick={() => {
                  if (!defaultModel) return;
                  void handleSend(prompt, {
                    model: defaultModel.id,
                    provider: defaultModel.provider,
                    source: defaultModel.source,
                    adapter: defaultModel.adapter,
                  });
                }}
                className="rounded-md border border-border px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <AiAssistantPanel projectId={projectId} variant="page" onClose={() => {}} />
      </div>
    </div>
  );
}

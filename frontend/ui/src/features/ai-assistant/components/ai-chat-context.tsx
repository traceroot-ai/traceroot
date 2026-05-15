"use client";

import { createContext, useContext, ReactNode } from "react";
import { useAiChat } from "../hooks/use-ai-chat";
import type { AiTraceContext } from "../types";

// Hoists useAiChat into a context so chat state survives the AiAssistantPanel
// component mounting/unmounting in different hosts (AppLayout's right rail,
// TraceViewerPanel's inner group, SessionDetailPanel's group). The provider
// itself lives at the AppLayout root and never unmounts during navigation
// within the app — this is what makes chat decouple from any single trace or
// session viewer (#784).
type ChatCtx = ReturnType<typeof useAiChat>;

const AiChatContext = createContext<ChatCtx | null>(null);

interface AiChatProviderProps {
  projectId: string | undefined;
  initialContext: AiTraceContext | null;
  children: ReactNode;
}

export function AiChatProvider({ projectId, initialContext, children }: AiChatProviderProps) {
  const chat = useAiChat({
    projectId,
    traceId: initialContext?.traceId,
    traceSessionId: initialContext?.traceSessionId,
  });
  return <AiChatContext.Provider value={chat}>{children}</AiChatContext.Provider>;
}

export function useAiChatContext(): ChatCtx {
  const ctx = useContext(AiChatContext);
  if (!ctx) {
    throw new Error("useAiChatContext must be used within an <AiChatProvider>");
  }
  return ctx;
}

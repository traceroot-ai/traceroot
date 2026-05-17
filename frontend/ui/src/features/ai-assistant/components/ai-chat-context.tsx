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
  // Pre-load an existing session (e.g. an RCA session opened from the detector
  // findings flow). When set, useAiChat fetches that session's messages and
  // continues attribution there. Clearing it lets the chat fall back to lazy
  // session creation on the next user message.
  initialSessionId?: string;
  children: ReactNode;
}

export function AiChatProvider({
  projectId,
  initialContext,
  initialSessionId,
  children,
}: AiChatProviderProps) {
  const chat = useAiChat({
    projectId,
    traceId: initialContext?.traceId,
    traceSessionId: initialContext?.traceSessionId,
    initialSessionId,
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

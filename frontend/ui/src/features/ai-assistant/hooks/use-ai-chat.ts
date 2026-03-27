"use client";

import { useRef, useState, useCallback } from "react";
import { useAIStream } from "./use-ai-stream";
import type { AISession, AIMessage } from "../types";
import type { ModelSelection } from "../components/model-selector";
 
interface RawApiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createTime: string;
}

interface UseAiChatOptions {
  projectId: string | undefined;
  traceId?: string;
  sessionId?: string;
}

export function useAiChat({ projectId, traceId, sessionId }: UseAiChatOptions) {
  const { messages, isStreaming, sendMessage, abort, setMessages } = useAIStream();
  const sessionIdRef = useRef<string | null>(null);
  const [sessions, setSessions] = useState<AISession[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  // isSending covers the gap between user hitting send and isStreaming becoming true
  // (session creation + first network round-trip). Without this, React 19 can batch
  // setIsStreaming(true) and setIsStreaming(false) into a single frame, hiding the button.
  const [isSending, setIsSending] = useState(false);

  // Lazy session creation — only when first message is sent
  const ensureSession = useCallback(async (): Promise<string | null> => {
    if (sessionIdRef.current) return sessionIdRef.current;
    if (!projectId) return null;
    try {
      const res = await fetch(`/api/projects/${projectId}/ai/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ traceId }),
      });
      if (!res.ok) throw new Error(`Failed to create session: ${res.status}`);
      const data = await res.json();
      sessionIdRef.current = data.id;
      return data.id;
    } catch (err) {
      console.error(err);
      return null;
    }
  }, [projectId, traceId]);

  const handleSend = useCallback(
    async (message: string, modelSelection: ModelSelection) => {
      if (!projectId) return;
      setIsSending(true);
      try {
        const aiSessionId = await ensureSession();
        if (!aiSessionId) return;
        sendMessage({
          sessionId: aiSessionId,
          message,
          projectId,
          model: modelSelection.model,
          providerName: modelSelection.provider,
          source: modelSelection.source,
          traceId,
          traceRootSessionId: sessionId,
        });
      } finally {
        setIsSending(false);
      }
    },
    [projectId, traceId, sessionId, ensureSession, sendMessage],
  );

  const handleNewSession = useCallback(() => {
    sessionIdRef.current = null;
    setMessages([]);
  }, [setMessages]);

  const handleOpenHistory = useCallback(async () => {
    if (!projectId) return;
    try {
      const res = await fetch(`/api/projects/${projectId}/ai/sessions`);
      const data = await res.json();
      setSessions(data.sessions || []);
      setHistoryOpen(true);
    } catch (err) {
      console.error(err);
    }
  }, [projectId]);

  const handleSelectSession = useCallback(
    async (session: AISession) => {
      sessionIdRef.current = session.id;
      setMessages([]);
      setHistoryOpen(false);

      if (!projectId) return;
      try {
        const res = await fetch(`/api/projects/${projectId}/ai/sessions/${session.id}/messages`);
        if (res.ok) {
          const data = await res.json();
          const loaded = (data.messages || []).map((m: RawApiMessage) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            timestamp: m.createTime,
          }));
          setMessages(loaded);
        }
      } catch (err) {
        console.error("[AI Chat] Failed to load session messages:", err);
      }
    },
    [projectId, setMessages],
  );

  const handleDeleteSession = useCallback(
    (sessionId: string) => {
      setSessions((prev: AISession[]) => prev.filter((s) => s.id !== sessionId));
      if (sessionIdRef.current === sessionId) {
        sessionIdRef.current = null;
        setMessages([]);
      }
    },
    [setMessages],
  );

  return {
    // State
    messages,
    isStreaming: isSending || isStreaming || messages.some((m: AIMessage) => m.isStreaming),
    sessions,
    historyOpen,
    currentSessionId: sessionIdRef.current,

    // Setters
    setHistoryOpen,

    // Actions
    handleSend,
    handleAbort: abort,
    handleNewSession,
    handleOpenHistory,
    handleSelectSession,
    handleDeleteSession,
  };
}

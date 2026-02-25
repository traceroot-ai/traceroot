"use client";

import { useRef, useState, useCallback } from "react";
import { useAIStream } from "./use-ai-stream";
import type { AISession, AIMessage } from "../types";

interface UseAiChatOptions {
  projectId: string | undefined;
  traceId?: string;
}

export function useAiChat({ projectId, traceId }: UseAiChatOptions) {
  const { messages, isStreaming, sendMessage, setMessages } = useAIStream();
  const sessionIdRef = useRef<string | null>(null);
  const [sessions, setSessions] = useState<AISession[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);

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
      const data = await res.json();
      sessionIdRef.current = data.id;
      return data.id;
    } catch (err) {
      console.error(err);
      return null;
    }
  }, [projectId, traceId]);

  const handleSend = useCallback(
    async (message: string, model: string) => {
      if (!projectId) return;
      const sessionId = await ensureSession();
      if (!sessionId) return;
      sendMessage({ sessionId, message, projectId, model, traceId });
    },
    [projectId, traceId, ensureSession, sendMessage],
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
          const loaded = (data.messages || []).map((m: any) => ({
            id: m.id,
            role: m.role as "user" | "assistant",
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
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
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
    isStreaming,
    sessions,
    historyOpen,
    currentSessionId: sessionIdRef.current,

    // Setters
    setHistoryOpen,

    // Actions
    handleSend,
    handleNewSession,
    handleOpenHistory,
    handleSelectSession,
    handleDeleteSession,
  };
}

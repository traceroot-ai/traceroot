"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { useAIStream } from "./use-ai-stream";
import type { AISession, AIMessage, AiTraceContext } from "../types";
import type { ModelSelection } from "../components/model-selector";

interface UseAiChatOptions extends AiTraceContext {
  projectId: string | undefined;
  initialSessionId?: string; // pre-load an existing session (e.g. RCA session from Step 2)
}

export function useAiChat({
  projectId,
  traceId,
  traceSessionId,
  initialSessionId,
}: UseAiChatOptions) {
  const { messages, isStreaming, sendMessage, abort, setMessages } = useAIStream();
  const sessionIdRef = useRef<string | null>(null);
  const [sessions, setSessions] = useState<AISession[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  // isSending covers the gap between user hitting send and isStreaming becoming true
  // (session creation + first network round-trip). Without this, React 19 can batch
  // setIsStreaming(true) and setIsStreaming(false) into a single frame, hiding the button.
  const [isSending, setIsSending] = useState(false);

  // Reset session when traceSessionId changes — only when there's no initialSessionId
  useEffect(() => {
    if (initialSessionId) return;
    sessionIdRef.current = null;
    setMessages([]);
  }, [traceSessionId, initialSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // When initialSessionId is provided, load that session's messages on mount / change.
  // AbortController guards against stale fetches: if the user navigates between
  // traces quickly, an older fetch resolving after a newer one would otherwise
  // overwrite the current session's messages.
  useEffect(() => {
    if (!initialSessionId || !projectId) return;
    sessionIdRef.current = initialSessionId;
    setMessages([]);

    const ac = new AbortController();
    fetch(`/api/projects/${projectId}/ai/sessions/${initialSessionId}/messages`, {
      signal: ac.signal,
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (ac.signal.aborted || !data) return;
        const all = (data.messages || []).map(
          (m: { id: string; role: string; content: string; createTime: string }) => ({
            id: m.id,
            role: m.role as "user" | "assistant",
            content: m.content,
            timestamp: m.createTime,
          }),
        );
        setMessages(all);
      })
      .catch((err) => {
        if (err?.name !== "AbortError")
          console.error("[AI Chat] Failed to load initial session:", err);
      });
    return () => ac.abort();
  }, [initialSessionId, projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lazy session creation — only when first message is sent
  const ensureSession = useCallback(async (): Promise<string | null> => {
    if (sessionIdRef.current) return sessionIdRef.current;
    if (!projectId) return null;
    try {
      const res = await fetch(`/api/projects/${projectId}/ai/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ traceId, traceSessionId }),
      });
      if (!res.ok) throw new Error(`Failed to create session: ${res.status}`);
      const data = await res.json();
      sessionIdRef.current = data.id;
      return data.id;
    } catch (err) {
      console.error(err);
      return null;
    }
  }, [projectId, traceId, traceSessionId]);

  const handleSend = useCallback(
    async (message: string, modelSelection: ModelSelection) => {
      if (!projectId) return;
      setIsSending(true);
      try {
        const sessionId = await ensureSession();
        if (!sessionId) return;
        sendMessage({
          sessionId,
          message,
          projectId,
          model: modelSelection.model,
          providerName: modelSelection.provider,
          source: modelSelection.source,
          traceId,
          traceSessionId,
        });
      } finally {
        setIsSending(false);
      }
    },
    [projectId, traceId, traceSessionId, ensureSession, sendMessage],
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
    isStreaming: isSending || isStreaming || messages.some((m) => m.isStreaming),
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

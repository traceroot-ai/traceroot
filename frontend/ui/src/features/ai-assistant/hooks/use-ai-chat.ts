"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { useAIStream } from "./use-ai-stream";
import type { AISession, AIMessage, AiTraceContext } from "../types";
import type { ModelSelection } from "../components/model-selector";

interface UseAiChatOptions extends AiTraceContext {
  projectId: string | undefined;
}

export function useAiChat({ projectId, traceId, traceSessionId }: UseAiChatOptions) {
  const {
    messages,
    isStreaming,
    sendMessage,
    abort,
    detachCurrentRun,
    reattachIfRunningForSession,
    setMessages,
  } = useAIStream();
  const sessionIdRef = useRef<string | null>(null);
  const [sessions, setSessions] = useState<AISession[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  // isSending covers the gap between user hitting send and isStreaming becoming true
  // (session creation + first network round-trip). Without this, React 19 can batch
  // setIsStreaming(true) and setIsStreaming(false) into a single frame, hiding the button.
  const [isSending, setIsSending] = useState(false);

  // Reset session + messages when the user navigates to a different project so
  // a session ID from project A can never be replayed against project B's chat
  // route. Within the same project, traceSessionId / traceId can change while
  // the chat is active (the user navigates between traces with the panel
  // open) — those don't reset; the latest values flow into handleSend below
  // so subsequent messages get the new context. handleNewSession /
  // handleSelectSession remain the explicit reset paths within a project.
  useEffect(() => {
    sessionIdRef.current = null;
    setMessages([]);
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

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
    // Detach (don't abort) any in-flight stream so its remaining SSE deltas
    // stop updating the visible messages — the backend run keeps going,
    // persists its result on onDone, and frees the agent for the next
    // prompt. Aborting the SSE here would leave the agent service stuck
    // mid-prompt and reject the next user message with "already
    // processing".
    detachCurrentRun();
    sessionIdRef.current = null;
    setMessages([]);
  }, [detachCurrentRun, setMessages]);

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
      // If the current in-flight stream belongs to the session we're
      // selecting, reattach it instead of detaching + reloading from DB —
      // the live deltas are more current than what's been persisted so far.
      const reattached = reattachIfRunningForSession(session.id);
      sessionIdRef.current = session.id;
      setHistoryOpen(false);
      if (reattached) {
        return;
      }

      // Otherwise detach the leaving stream (it keeps reading on the FE so
      // the BE can finish + persist + free its agent) and load the chosen
      // session's messages from the DB.
      detachCurrentRun();
      setMessages([]);

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
    [detachCurrentRun, reattachIfRunningForSession, projectId, setMessages],
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

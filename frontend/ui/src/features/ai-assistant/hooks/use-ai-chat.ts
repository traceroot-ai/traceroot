"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { useAIStream } from "./use-ai-stream";
import { mapPersistedMessage } from "./message-history";
import type { AISession, AiTraceContext } from "../types";
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
  // Set so concurrent ensureSession calls don't cancel each other; handleClose
  // aborts all in-flight POST /sessions to prevent post-close resurrection.
  const ensureSessionAbortersRef = useRef<Set<AbortController>>(new Set());
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
  // When initialSessionId is set, the loading useEffect below owns session
  // ownership, so we bail here to avoid clobbering its fetched messages.
  useEffect(() => {
    if (initialSessionId) return;
    sessionIdRef.current = null;
    setMessages([]);
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // When initialSessionId is provided, load that session's messages on mount / change.
  // AbortController guards against stale fetches: if the user switches between
  // RCA sessions quickly, an older fetch resolving after a newer one would
  // otherwise overwrite the current session's messages.
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
        const all = (data.messages || []).map(mapPersistedMessage);
        setMessages(all);
      })
      .catch((err) => {
        if (err?.name !== "AbortError")
          console.error("[AI Chat] Failed to load initial session:", err);
      });
    return () => ac.abort();
  }, [initialSessionId, projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lazy session creation — only when first message is sent. The fetch is
  // cancellable so handleClose can prevent a pending response from resurrecting
  // sessionIdRef after we've cleared it. Caller commits the id on success.
  const ensureSession = useCallback(async (): Promise<string | null> => {
    if (sessionIdRef.current) return sessionIdRef.current;
    if (!projectId) return null;
    const ac = new AbortController();
    ensureSessionAbortersRef.current.add(ac);
    try {
      const res = await fetch(`/api/projects/${projectId}/ai/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ traceId, traceSessionId }),
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`Failed to create session: ${res.status}`);
      const data = await res.json();
      return data.id;
    } catch (err) {
      if ((err as Error).name !== "AbortError") console.error(err);
      return null;
    } finally {
      ensureSessionAbortersRef.current.delete(ac);
    }
  }, [projectId, traceId, traceSessionId]);

  const handleSend = useCallback(
    async (message: string, modelSelection: ModelSelection) => {
      if (!projectId) return;
      setIsSending(true);
      try {
        const sessionId = await ensureSession();
        if (!sessionId) return;
        sessionIdRef.current = sessionId;
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
    // Note: a still-running stream from the previous session keeps reading
    // in the background. Its SSE deltas may briefly bleed into this fresh
    // chat view until the backend turn completes — tracked separately as a
    // follow-up (see the linked discussion / issue on #784).
    sessionIdRef.current = null;
    setMessages([]);
  }, [setMessages]);

  // Closing the panel ends the conversation: any in-flight run is aborted,
  // and the session id + messages are dropped so the next reopen starts
  // fresh. History list remains the way back to past sessions (server-side).
  // Switching traces within the same page does NOT trigger this — the panel
  // stays open in that case.
  const handleClose = useCallback(() => {
    for (const ac of ensureSessionAbortersRef.current) ac.abort();
    ensureSessionAbortersRef.current.clear();
    abort();
    sessionIdRef.current = null;
    setMessages([]);
  }, [abort, setMessages]);

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
          const loaded = (data.messages || []).map(mapPersistedMessage);
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
    handleClose,
    handleOpenHistory,
    handleSelectSession,
    handleDeleteSession,
  };
}

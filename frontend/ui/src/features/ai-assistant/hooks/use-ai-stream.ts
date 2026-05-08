"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import type { AIMessage } from "../types";

/** Generate a UUID that works in both secure (HTTPS) and insecure (HTTP) contexts. */
function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for HTTP (non-secure) contexts where crypto.randomUUID is unavailable
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function useAIStream() {
  const [messages, setMessages] = useState<AIMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  // Tracks the ID of the currently-active assistant text bubble.
  // null means no text bubble is open yet (e.g. before the first text delta,
  // or right after a tool call was appended).
  const currentTextIdRef = useRef<string | null>(null);
  // Tracks the last frozen bubble ID so usage stats from message_end can still
  // be attached when a turn ends with a tool call (currentTextIdRef is null then).
  const lastFrozenIdRef = useRef<string | null>(null);
  // The currently-active run, tracked separately from a "stale" flag so a
  // session switch can pause delta application without permanently dropping
  // the run — coming back to the same session reactivates the run so its
  // remaining deltas are applied again, instead of leaving the user with an
  // empty chat while the backend is still streaming.
  const currentRunRef = useRef<{
    runId: string;
    sessionId: string;
    stale: boolean;
  } | null>(null);

  const detachCurrentRun = useCallback(() => {
    if (currentRunRef.current) {
      currentRunRef.current = { ...currentRunRef.current, stale: true };
    }
    setIsStreaming(false);
  }, []);

  // If a still-running stream belongs to `sessionId`, mark it live again so
  // its incoming deltas resume updating the visible messages. Returns true
  // if a stream was reattached (the caller should skip reloading from DB
  // since live data is more current).
  const reattachIfRunningForSession = useCallback((sessionId: string): boolean => {
    const run = currentRunRef.current;
    if (run && run.sessionId === sessionId) {
      currentRunRef.current = { ...run, stale: false };
      setIsStreaming(true);
      return true;
    }
    return false;
  }, []);

  const sendMessage = useCallback(
    async (params: {
      sessionId: string;
      message: string;
      projectId: string;
      model?: string;
      providerName?: string;
      source?: "system" | "byok";
      traceId?: string;
      traceSessionId?: string;
    }) => {
      const runId = generateId();
      currentRunRef.current = { runId, sessionId: params.sessionId, stale: false };
      const isLive = () => currentRunRef.current?.runId === runId && !currentRunRef.current.stale;
      const safeSetMessages: typeof setMessages = (updater) => {
        if (!isLive()) return;
        setMessages(updater);
      };

      const userMsg: AIMessage = {
        id: generateId(),
        role: "user",
        content: params.message,
        timestamp: new Date().toISOString(),
      };
      safeSetMessages((prev) => [...prev, userMsg]);

      setIsStreaming(true);
      currentTextIdRef.current = null;
      lastFrozenIdRef.current = null;

      // Opens a new streaming assistant text bubble and returns its id.
      // Subsequent text deltas append to this bubble until it is frozen.
      const openTextBubble = (): string => {
        const id = generateId();
        currentTextIdRef.current = id;
        safeSetMessages((prev) => [
          ...prev,
          {
            id,
            role: "assistant",
            content: "",
            timestamp: new Date().toISOString(),
            isStreaming: true,
          },
        ]);
        return id;
      };

      // Stops the currently-active text bubble from streaming (freezes it).
      const freezeCurrentBubble = () => {
        if (!currentTextIdRef.current) return;
        const frozenId = currentTextIdRef.current;
        lastFrozenIdRef.current = frozenId;
        currentTextIdRef.current = null;
        safeSetMessages((prev) =>
          prev.map((m) => (m.id === frozenId ? { ...m, isStreaming: false } : m)),
        );
      };

      // Helper: show an error in the current bubble or open a new one.
      const showError = (errorMessage: string) => {
        const targetId = currentTextIdRef.current ?? openTextBubble();
        safeSetMessages((prev) =>
          prev.map((m) =>
            m.id === targetId ? { ...m, content: `Error: ${errorMessage}`, isStreaming: false } : m,
          ),
        );
        currentTextIdRef.current = null;
      };

      const abortController = new AbortController();
      abortRef.current = abortController;

      try {
        // Goes through Next.js proxy which handles auth + adds headers
        const url = `/api/projects/${params.projectId}/ai/sessions/${params.sessionId}/messages`;
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: params.message,
            model: params.model,
            providerName: params.providerName,
            source: params.source,
            traceId: params.traceId,
            traceSessionId: params.traceSessionId,
          }),
          signal: abortController.signal,
        });

        if (!response.ok) {
          const errorBody = await response.json().catch(() => null);
          showError(errorBody?.error || `HTTP ${response.status}`);
          return;
        }
        if (!response.body) throw new Error("No response body");

        const reader = response.body.getReader();
        readerRef.current = reader;
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const eventData = JSON.parse(line.slice(6));

                if (eventData.type === "message_update") {
                  const delta = eventData.assistantMessageEvent;

                  if (delta?.type === "text_delta" && delta.delta) {
                    // Open a new bubble if there isn't one (first text, or post-tool text)
                    if (!currentTextIdRef.current) openTextBubble();
                    const targetId = currentTextIdRef.current!;
                    safeSetMessages((prev) =>
                      prev.map((msg) =>
                        msg.id === targetId ? { ...msg, content: msg.content + delta.delta } : msg,
                      ),
                    );
                  }

                  if (delta?.type === "thinking_delta" && delta.delta) {
                    if (!currentTextIdRef.current) openTextBubble();
                    const targetId = currentTextIdRef.current!;
                    safeSetMessages((prev) =>
                      prev.map((msg) =>
                        msg.id === targetId
                          ? { ...msg, thinking: (msg.thinking ?? "") + delta.delta }
                          : msg,
                      ),
                    );
                  }
                }

                // Capture usage stats on the last text bubble
                if (eventData.type === "message_end") {
                  const msg = eventData.message;

                  if (msg?.stopReason === "error" && msg.errorMessage) {
                    showError(msg.errorMessage);
                  }

                  if (msg?.usage) {
                    const lastId = currentTextIdRef.current ?? lastFrozenIdRef.current;
                    if (lastId) {
                      safeSetMessages((prev) =>
                        prev.map((m) =>
                          m.id === lastId
                            ? {
                                ...m,
                                inputTokens: msg.usage.input,
                                outputTokens: msg.usage.output,
                                totalTokens: msg.usage.totalTokens,
                                costUsd: msg.usage.cost?.total,
                              }
                            : m,
                        ),
                      );
                    }
                  }
                }

                // Tool call starts: freeze current text bubble, then append the tool step
                if (eventData.type === "tool_execution_start") {
                  freezeCurrentBubble();

                  const toolStepMsg: AIMessage = {
                    id: eventData.toolCallId,
                    role: "tool_step",
                    content: "",
                    timestamp: new Date().toISOString(),
                    toolStep: {
                      toolCallId: eventData.toolCallId,
                      toolName: eventData.toolName,
                      args: eventData.args ?? {},
                      status: "running",
                    },
                  };
                  safeSetMessages((prev) => [...prev, toolStepMsg]);
                }

                if (eventData.type === "tool_execution_end") {
                  safeSetMessages((prev) =>
                    prev.map((m) =>
                      m.id === eventData.toolCallId
                        ? {
                            ...m,
                            toolStep: {
                              ...m.toolStep!,
                              result: eventData.result,
                              isError: eventData.isError,
                              status: eventData.isError ? ("error" as const) : ("done" as const),
                            },
                          }
                        : m,
                    ),
                  );
                }

                if (eventData.type === "error") {
                  const errorMsg =
                    eventData.message || eventData.error?.errorMessage || "Unknown error";
                  showError(errorMsg);
                }
              } catch {
                // Skip unparseable lines
              }
            }
          }
        }
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          console.error("[AI Stream] Error:", error);
          showError((error as Error).message || "Failed to get response.");
        }
      } finally {
        // Freeze the last open bubble (if streaming was cut short)
        freezeCurrentBubble();
        // Only clear isStreaming + the run pointer if this run is still the
        // one in flight. If a newer run has taken over (user sent another
        // message before this one finished) or the run was detached,
        // leave their state untouched.
        if (currentRunRef.current?.runId === runId) {
          if (isLive()) setIsStreaming(false);
          currentRunRef.current = null;
        }
        abortRef.current = null;
        readerRef.current = null;
      }
    },
    [],
  );

  const abort = useCallback(() => {
    readerRef.current?.cancel();
    abortRef.current?.abort();
  }, []);

  // Defensive cleanup: if the host component truly unmounts (logout, tab
  // close, hard route swap), abort any in-flight stream so we don't leak the
  // SSE connection or keep burning LLM tokens after the UI is gone.
  useEffect(() => {
    return () => {
      readerRef.current?.cancel();
      abortRef.current?.abort();
    };
  }, []);

  return {
    messages,
    isStreaming,
    sendMessage,
    abort,
    detachCurrentRun,
    reattachIfRunningForSession,
    setMessages,
  };
}

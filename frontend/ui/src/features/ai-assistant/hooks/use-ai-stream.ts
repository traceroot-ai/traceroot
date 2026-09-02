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

/** Freeze any still-streaming bubbles in a message list. */
function frozen(messages: AIMessage[]): AIMessage[] {
  return messages.map((m) => (m.isStreaming ? { ...m, isStreaming: false } : m));
}

interface SessionRun {
  /** Monotonic id — a bucket write is valid only while this run is still the
   * session's registered run with the same generation. */
  gen: number;
  abortController: AbortController;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
}

/**
 * Streams agent responses into per-session message buckets.
 *
 * Every state element is keyed by sessionId so an in-flight SSE run keeps
 * writing to the session it belongs to — switching the visible session can
 * never make another session's deltas bleed into the current view, and a
 * still-running session shows its accumulated progress when the user returns
 * to it.
 */
export function useAIStream() {
  const [messagesBySession, setMessagesBySession] = useState<Record<string, AIMessage[]>>({});
  const [streamingSessions, setStreamingSessions] = useState<Record<string, boolean>>({});
  const runsRef = useRef<Map<string, SessionRun>>(new Map());
  const genRef = useRef(0);

  const updateBucket = useCallback(
    (sessionId: string, updater: (prev: AIMessage[]) => AIMessage[]) => {
      setMessagesBySession((prev) => ({ ...prev, [sessionId]: updater(prev[sessionId] ?? []) }));
    },
    [],
  );

  /** Cancel a session's in-flight run (reader + fetch). State cleanup is the caller's job. */
  const stopRun = useCallback((sessionId: string) => {
    const run = runsRef.current.get(sessionId);
    if (!run) return;
    runsRef.current.delete(sessionId);
    run.reader?.cancel().catch(() => {});
    run.abortController.abort();
  }, []);

  const clearStreamingFlag = useCallback((sessionId: string) => {
    setStreamingSessions((prev) => {
      if (!(sessionId in prev)) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }, []);

  const abortSession = useCallback(
    (sessionId: string) => {
      stopRun(sessionId);
      clearStreamingFlag(sessionId);
      updateBucket(sessionId, frozen);
    },
    [stopRun, clearStreamingFlag, updateBucket],
  );

  const abortAll = useCallback(() => {
    for (const sessionId of [...runsRef.current.keys()]) stopRun(sessionId);
    setStreamingSessions({});
    setMessagesBySession((prev) =>
      Object.fromEntries(Object.entries(prev).map(([id, msgs]) => [id, frozen(msgs)])),
    );
  }, [stopRun]);

  const clearAll = useCallback(() => {
    setMessagesBySession({});
    setStreamingSessions({});
  }, []);

  /** Replace a session's cached messages (history loads). */
  const setSessionMessages = useCallback((sessionId: string, messages: AIMessage[]) => {
    setMessagesBySession((prev) => ({ ...prev, [sessionId]: messages }));
  }, []);

  /**
   * Synchronous truth for "does this session have a live run?". Unlike the
   * streamingSessions state (which lags until the next render), runsRef is
   * registered before sendMessage's first await, so callers racing a send —
   * e.g. a history fetch resolving after the user sent a message — get an
   * exact answer.
   */
  const isSessionStreaming = useCallback((sessionId: string) => runsRef.current.has(sessionId), []);

  /** Drop a session entirely (delete): cancel its run and forget its bucket. */
  const removeSession = useCallback(
    (sessionId: string) => {
      stopRun(sessionId);
      clearStreamingFlag(sessionId);
      setMessagesBySession((prev) => {
        if (!(sessionId in prev)) return prev;
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
    },
    [stopRun, clearStreamingFlag],
  );

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
      const { sessionId } = params;
      const myGen = ++genRef.current;

      // Single-flight per session: cancel a prior run in THIS session only.
      // Runs in other sessions keep streaming into their own buckets.
      stopRun(sessionId);

      const abortController = new AbortController();
      const run: SessionRun = { gen: myGen, abortController, reader: null };
      runsRef.current.set(sessionId, run);

      // Valid only while this run is still the session's registered run —
      // superseded/aborted runs' buffered chunks become no-ops.
      const safeUpdate = (updater: (prev: AIMessage[]) => AIMessage[]) => {
        if (runsRef.current.get(sessionId)?.gen !== myGen) return;
        updateBucket(sessionId, updater);
      };

      // Bubble tracking is local to this run so superseded streams cannot
      // mutate the live run's state via shared refs.
      let currentTextId: string | null = null;
      let lastFrozenId: string | null = null;

      const userMsg: AIMessage = {
        id: generateId(),
        role: "user",
        content: params.message,
        timestamp: new Date().toISOString(),
      };
      // Freeze any bubble a superseded run left open, then append the user turn.
      safeUpdate((prev) => [...frozen(prev), userMsg]);

      setStreamingSessions((prev) => ({ ...prev, [sessionId]: true }));

      // Opens a new streaming assistant text bubble and returns its id.
      // Subsequent text deltas append to this bubble until it is frozen.
      const openTextBubble = (): string => {
        const id = generateId();
        currentTextId = id;
        safeUpdate((prev) => [
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
        if (!currentTextId) return;
        const frozenId = currentTextId;
        lastFrozenId = frozenId;
        currentTextId = null;
        safeUpdate((prev) =>
          prev.map((m) => (m.id === frozenId ? { ...m, isStreaming: false } : m)),
        );
      };

      // Helper: show an error in the current bubble or open a new one.
      const showError = (errorMessage: string) => {
        const targetId = currentTextId ?? openTextBubble();
        safeUpdate((prev) =>
          prev.map((m) =>
            m.id === targetId ? { ...m, content: `Error: ${errorMessage}`, isStreaming: false } : m,
          ),
        );
        currentTextId = null;
      };

      try {
        // Goes through Next.js proxy which handles auth + adds headers
        const url = `/api/projects/${params.projectId}/ai/sessions/${sessionId}/messages`;
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
        run.reader = reader;
        const decoder = new TextDecoder();
        let buffer = "";
        // Name from the preceding `event:` line, consumed by the next `data:`
        // line. The agent's final trace event is a NAMED event whose payload
        // has no `type` field, so without this it would be silently skipped
        // and the live message would never grow its "View trace" link.
        let namedEvent = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("event: ")) {
              namedEvent = line.slice(7).trim();
              continue;
            }
            if (line.startsWith("data: ")) {
              try {
                const eventData = JSON.parse(line.slice(6));

                if (namedEvent === "trace") {
                  // {status, traceId} — same fields the persisted row carries,
                  // so the reloaded session renders the identical footer link.
                  if (eventData.traceId && eventData.status !== "disabled") {
                    const lastId = currentTextId ?? lastFrozenId;
                    if (lastId) {
                      safeUpdate((prev) =>
                        prev.map((m) =>
                          m.id === lastId
                            ? { ...m, traceId: eventData.traceId, traceStatus: eventData.status }
                            : m,
                        ),
                      );
                    }
                  }
                  namedEvent = "";
                  continue;
                }
                namedEvent = "";

                if (eventData.type === "message_update") {
                  const delta = eventData.assistantMessageEvent;

                  if (delta?.type === "text_delta" && delta.delta) {
                    // Open a new bubble if there isn't one (first text, or post-tool text)
                    if (!currentTextId) openTextBubble();
                    const targetId = currentTextId!;
                    safeUpdate((prev) =>
                      prev.map((msg) =>
                        msg.id === targetId ? { ...msg, content: msg.content + delta.delta } : msg,
                      ),
                    );
                  }

                  if (delta?.type === "thinking_delta" && delta.delta) {
                    if (!currentTextId) openTextBubble();
                    const targetId = currentTextId!;
                    safeUpdate((prev) =>
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
                    const lastId = currentTextId ?? lastFrozenId;
                    if (lastId) {
                      safeUpdate((prev) =>
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
                  safeUpdate((prev) => [...prev, toolStepMsg]);
                }

                if (eventData.type === "tool_execution_end") {
                  safeUpdate((prev) =>
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
        // Freeze the last open bubble (if streaming was cut short).
        freezeCurrentBubble();
        // Skip cleanup if a newer run owns this session — would clobber its state.
        if (runsRef.current.get(sessionId)?.gen === myGen) {
          runsRef.current.delete(sessionId);
          clearStreamingFlag(sessionId);
        }
      }
    },
    [stopRun, updateBucket, clearStreamingFlag],
  );

  // Defensive cleanup: if the host component truly unmounts (logout, tab
  // close, hard route swap), abort every in-flight stream so we don't leak
  // SSE connections or keep burning LLM tokens after the UI is gone.
  useEffect(() => {
    const runs = runsRef.current;
    return () => {
      for (const run of runs.values()) {
        run.reader?.cancel().catch(() => {});
        run.abortController.abort();
      }
      runs.clear();
    };
  }, []);

  return {
    messagesBySession,
    streamingSessions,
    isSessionStreaming,
    sendMessage,
    setSessionMessages,
    abortSession,
    abortAll,
    clearAll,
    removeSession,
  };
}

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
  // Bumped on send AND on abort — invalidates in-flight setMessages from prior streams.
  const generationRef = useRef(0);
  // Bumped only on send — finally checks this to distinguish "I was aborted"
  // from "a newer send superseded me" (only the latter must skip cleanup).
  const latestSendRef = useRef(0);

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
      const myGen = ++generationRef.current;
      latestSendRef.current = myGen;
      const safeSetMessages: typeof setMessages = (updater) => {
        if (generationRef.current !== myGen) return;
        setMessages(updater);
      };

      // Cancel any prior in-flight stream so its tail chunks can't race with this run.
      readerRef.current?.cancel();
      abortRef.current?.abort();

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
      safeSetMessages((prev) => [...prev, userMsg]);

      setIsStreaming(true);

      // Opens a new streaming assistant text bubble and returns its id.
      // Subsequent text deltas append to this bubble until it is frozen.
      const openTextBubble = (): string => {
        const id = generateId();
        currentTextId = id;
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
        if (!currentTextId) return;
        const frozenId = currentTextId;
        lastFrozenId = frozenId;
        currentTextId = null;
        safeSetMessages((prev) =>
          prev.map((m) => (m.id === frozenId ? { ...m, isStreaming: false } : m)),
        );
      };

      // Helper: show an error in the current bubble or open a new one.
      const showError = (errorMessage: string) => {
        const targetId = currentTextId ?? openTextBubble();
        safeSetMessages((prev) =>
          prev.map((m) =>
            m.id === targetId ? { ...m, content: `Error: ${errorMessage}`, isStreaming: false } : m,
          ),
        );
        currentTextId = null;
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
                    if (!currentTextId) openTextBubble();
                    const targetId = currentTextId!;
                    safeSetMessages((prev) =>
                      prev.map((msg) =>
                        msg.id === targetId ? { ...msg, content: msg.content + delta.delta } : msg,
                      ),
                    );
                  }

                  if (delta?.type === "thinking_delta" && delta.delta) {
                    if (!currentTextId) openTextBubble();
                    const targetId = currentTextId!;
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
                    const lastId = currentTextId ?? lastFrozenId;
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
        // Freeze the last open bubble (if streaming was cut short).
        freezeCurrentBubble();
        // Skip cleanup if a newer send already began — would clobber its state.
        if (latestSendRef.current === myGen) {
          setIsStreaming(false);
          abortRef.current = null;
          readerRef.current = null;
        }
      }
    },
    [],
  );

  const abort = useCallback(() => {
    // Bump first so chunks still buffered in the stream loop noop via safeSetMessages.
    generationRef.current++;
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

  return { messages, isStreaming, sendMessage, abort, setMessages };
}

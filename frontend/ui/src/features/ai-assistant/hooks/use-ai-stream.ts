"use client";

import { useState, useCallback, useRef } from "react";
import type { AIMessage, ToolCallStep } from "../types";

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

  const sendMessage = useCallback(
    async (params: {
      sessionId: string;
      message: string;
      projectId: string;
      model?: string;
      providerName?: string;
      source?: "system" | "byok"; // ModelSource values
      traceId?: string;
    }) => {
      // Add user message
      const userMsg: AIMessage = {
        id: generateId(),
        role: "user",
        content: params.message,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMsg]);

      // Start streaming assistant response
      setIsStreaming(true);
      const assistantMsgId = generateId();

      setMessages((prev) => [
        ...prev,
        {
          id: assistantMsgId,
          role: "assistant",
          content: "",
          timestamp: new Date().toISOString(),
          isStreaming: true,
        },
      ]);

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
          }),
          signal: abortController.signal,
        });

        if (!response.ok) {
          const errorBody = await response.json().catch(() => null);
          const errorMessage = errorBody?.error || `HTTP ${response.status}`;
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMsgId
                ? { ...msg, content: `Error: ${errorMessage}`, isStreaming: false }
                : msg,
            ),
          );
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
                // pi-agent-core message_update events contain assistantMessageEvent
                // with type "text_delta" (or "thinking_delta" for reasoning models like DeepSeek)
                // and a delta string (the incremental text).
                if (eventData.type === "message_update") {
                  const delta = eventData.assistantMessageEvent;
                  if (delta?.type === "text_delta" && delta.delta) {
                    setMessages((prev) =>
                      prev.map((msg) =>
                        msg.id === assistantMsgId
                          ? { ...msg, content: msg.content + delta.delta }
                          : msg,
                      ),
                    );
                  }
                  if (delta?.type === "thinking_delta" && delta.delta) {
                    setMessages((prev) =>
                      prev.map((msg) =>
                        msg.id === assistantMsgId
                          ? { ...msg, thinking: (msg.thinking ?? "") + delta.delta }
                          : msg,
                      ),
                    );
                  }
                }
                // Show API errors and capture usage stats
                if (eventData.type === "message_end") {
                  const msg = eventData.message;

                  if (msg?.stopReason === "error" && msg.errorMessage) {
                    setMessages((prev) =>
                      prev.map((m) =>
                        m.id === assistantMsgId
                          ? { ...m, content: `Error: ${msg.errorMessage}`, isStreaming: false }
                          : m,
                      ),
                    );
                  }

                  if (msg?.usage) {
                    setMessages((prev) =>
                      prev.map((m) =>
                        m.id === assistantMsgId
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
                if (eventData.type === "tool_execution_start") {
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
                  setMessages((prev) => {
                    const idx = prev.findIndex((m) => m.id === assistantMsgId);
                    // Insert just before the assistant placeholder; if not found, insert second-to-last
                    const insertAt = idx !== -1 ? idx : Math.max(0, prev.length - 1);
                    return [...prev.slice(0, insertAt), toolStepMsg, ...prev.slice(insertAt)];
                  });
                }
                if (eventData.type === "tool_execution_end") {
                  setMessages((prev) =>
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
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === assistantMsgId
                        ? { ...m, content: `Error: ${errorMsg}`, isStreaming: false }
                        : m,
                    ),
                  );
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
          const errorMessage = (error as Error).message || "Failed to get response.";
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMsgId
                ? {
                    ...msg,
                    content: msg.content || `Error: ${errorMessage}`,
                    isStreaming: false,
                  }
                : msg,
            ),
          );
        }
      } finally {
        setIsStreaming(false);
        setMessages((prev) =>
          prev.map((msg) => (msg.id === assistantMsgId ? { ...msg, isStreaming: false } : msg)),
        );
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

  return { messages, isStreaming, sendMessage, abort, setMessages };
}

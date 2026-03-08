"use client";

import { useState, useCallback, useRef } from "react";
import type { AIMessage } from "../types";

export function useAIStream() {
  const [messages, setMessages] = useState<AIMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

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
        id: crypto.randomUUID(),
        role: "user",
        content: params.message,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMsg]);

      // Start streaming assistant response
      setIsStreaming(true);
      const assistantMsgId = crypto.randomUUID();

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
                  // Handle both text_delta and thinking_delta (for DeepSeek reasoner)
                  if (
                    (delta?.type === "text_delta" || delta?.type === "thinking_delta") &&
                    delta.delta
                  ) {
                    setMessages((prev) =>
                      prev.map((msg) =>
                        msg.id === assistantMsgId
                          ? { ...msg, content: msg.content + delta.delta }
                          : msg,
                      ),
                    );
                  }
                }
                // Show API errors to the user
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
      }
    },
    [],
  );

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { messages, isStreaming, sendMessage, abort, setMessages };
}

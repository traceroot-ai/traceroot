// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

vi.mock("./use-ai-stream", () => ({
  useAIStream: () => ({
    messages: [],
    isStreaming: false,
    sendMessage: vi.fn(),
    abort: vi.fn(),
    setMessages: vi.fn(),
  }),
}));

import { useAiChat } from "./use-ai-chat";

describe("useAiChat.getCurrentSessionId", () => {
  it("returns null before any session is created", () => {
    const { result } = renderHook(() => useAiChat({ projectId: "proj-1" }));
    expect(result.current.getCurrentSessionId()).toBeNull();
  });
});

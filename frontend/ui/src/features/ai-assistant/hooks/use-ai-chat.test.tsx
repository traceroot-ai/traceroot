// @vitest-environment jsdom
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

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

const PICK = { model: "kimi-k3", provider: "Moonshot", source: "byok" as const, adapter: "openai" };

afterEach(() => {
  window.localStorage.clear();
});

describe("useAiChat model selection", () => {
  it("starts empty and exposes a setter", () => {
    const { result } = renderHook(() => useAiChat({ projectId: "p1" }));
    expect(result.current.modelSelection.model).toBe("");
    act(() => result.current.setModelSelection(PICK));
    expect(result.current.modelSelection).toEqual(PICK);
  });

  it("restores the selection for the same project after a remount", () => {
    const first = renderHook(() => useAiChat({ projectId: "p1" }));
    act(() => first.result.current.setModelSelection(PICK));
    first.unmount();

    const second = renderHook(() => useAiChat({ projectId: "p1" }));
    expect(second.result.current.modelSelection).toEqual(PICK);
  });

  it("switches to the other project's selection without a stale render in between", () => {
    const OTHER = { ...PICK, model: "gpt-5" };
    const seen: string[] = [];
    const { result, rerender } = renderHook(
      ({ projectId }) => {
        const chat = useAiChat({ projectId });
        const model = chat.modelSelection.model;
        // Record committed states only: that is what consumer effects observe.
        useEffect(() => {
          seen.push(`${projectId}:${model}`);
        }, [projectId, model]);
        return chat;
      },
      { initialProps: { projectId: "p1" } },
    );
    act(() => result.current.setModelSelection(PICK));
    rerender({ projectId: "p2" });
    act(() => result.current.setModelSelection(OTHER));
    rerender({ projectId: "p1" });
    expect(result.current.modelSelection).toEqual(PICK);
    // p2 must never have been rendered with p1's pick (that render is what lets
    // the selector's auto-pick overwrite p2's stored choice), and vice versa.
    expect(seen).not.toContain("p2:kimi-k3");
    expect(seen).not.toContain("p1:gpt-5");
  });

  it("keeps selections separate per project", () => {
    const a = renderHook(() => useAiChat({ projectId: "p1" }));
    act(() => a.result.current.setModelSelection(PICK));
    a.unmount();

    const b = renderHook(() => useAiChat({ projectId: "p2" }));
    expect(b.result.current.modelSelection.model).toBe("");
  });
});

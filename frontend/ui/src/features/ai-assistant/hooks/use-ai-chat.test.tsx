// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

const sendMessage = vi.fn();

vi.mock("./use-ai-stream", () => ({
  useAIStream: () => ({
    messages: [],
    isStreaming: false,
    sendMessage,
    abort: vi.fn(),
    setMessages: vi.fn(),
  }),
}));

import { useAiChat } from "./use-ai-chat";

afterEach(() => {
  vi.unstubAllGlobals();
  sendMessage.mockReset();
});

describe("useAiChat — session-creation error surfacing", () => {
  it("sets sendError from the response body when session creation is forbidden", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ error: "Requires MEMBER role or higher" }),
      }),
    );

    const { result } = renderHook(() => useAiChat({ projectId: "proj-1" }));

    await act(async () => {
      await result.current.handleSend("hello", {
        model: "claude-4",
        provider: "anthropic",
        source: "system",
        adapter: "anthropic",
      });
    });

    await waitFor(() => expect(result.current.sendError).toBe("Requires MEMBER role or higher"));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("falls back to a generic message when the failed response has no error body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error("not json");
        },
      }),
    );

    const { result } = renderHook(() => useAiChat({ projectId: "proj-1" }));

    await act(async () => {
      await result.current.handleSend("hello", {
        model: "claude-4",
        provider: "anthropic",
        source: "system",
        adapter: "anthropic",
      });
    });

    await waitFor(() => expect(result.current.sendError).toBe("Failed to create session: 500"));
  });

  it("clears a prior sendError on the next send attempt once it succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({ error: "Requires MEMBER role or higher" }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "sess-1" }) });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useAiChat({ projectId: "proj-1" }));
    const modelSelection = {
      model: "claude-4",
      provider: "anthropic",
      source: "system" as const,
      adapter: "anthropic",
    };

    await act(async () => {
      await result.current.handleSend("first", modelSelection);
    });
    await waitFor(() => expect(result.current.sendError).toBe("Requires MEMBER role or higher"));

    await act(async () => {
      await result.current.handleSend("second", modelSelection);
    });
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(result.current.sendError).toBeNull();
  });

  it("clears sendError when the user starts a new session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({ error: "Requires MEMBER role or higher" }),
      }),
    );

    const { result } = renderHook(() => useAiChat({ projectId: "proj-1" }));

    await act(async () => {
      await result.current.handleSend("hello", {
        model: "claude-4",
        provider: "anthropic",
        source: "system",
        adapter: "anthropic",
      });
    });
    await waitFor(() => expect(result.current.sendError).toBe("Requires MEMBER role or higher"));

    act(() => {
      result.current.handleNewSession();
    });

    expect(result.current.sendError).toBeNull();
  });
});

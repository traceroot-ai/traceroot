// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AISession } from "../types";
import { useAiChat } from "./use-ai-chat";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function session(id: string): AISession {
  return {
    id,
    projectId: "project-1",
    title: id,
    status: "active",
    createTime: "2026-08-03T00:00:00.000Z",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mockAbortableFetch() {
  let signal: AbortSignal | undefined;
  const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener(
        "abort",
        () => reject(new DOMException("The operation was aborted", "AbortError")),
        { once: true },
      );
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, getSignal: () => signal };
}

describe("useAiChat session history", () => {
  it("keeps the latest selection when message requests resolve out of order", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useAiChat({ projectId: "project-1" }));

    let firstSelection!: Promise<void>;
    let secondSelection!: Promise<void>;
    act(() => {
      firstSelection = result.current.handleSelectSession(session("session-a"));
    });
    act(() => {
      secondSelection = result.current.handleSelectSession(session("session-b"));
    });

    second.resolve(
      new Response(
        JSON.stringify({
          messages: [
            {
              id: "message-b",
              role: "assistant",
              content: "Session B",
              createTime: "2026-08-03T00:00:02.000Z",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await act(async () => secondSelection);

    expect(result.current.currentSessionId).toBe("session-b");
    expect(result.current.messages.map((message) => message.content)).toEqual(["Session B"]);

    first.resolve(
      new Response(
        JSON.stringify({
          messages: [
            {
              id: "message-a",
              role: "assistant",
              content: "Session A",
              createTime: "2026-08-03T00:00:01.000Z",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await act(async () => firstSelection);

    expect(result.current.currentSessionId).toBe("session-b");
    expect(result.current.messages.map((message) => message.content)).toEqual(["Session B"]);
  });

  it("cancels a pending history load when starting a new session", async () => {
    const { getSignal } = mockAbortableFetch();
    const { result } = renderHook(() => useAiChat({ projectId: "project-1" }));

    let selection!: Promise<void>;
    act(() => {
      selection = result.current.handleSelectSession(session("session-a"));
    });
    act(() => result.current.handleNewSession());
    await act(async () => selection);

    expect(getSignal()?.aborted).toBe(true);
    expect(result.current.currentSessionId).toBeNull();
    expect(result.current.messages).toEqual([]);
  });

  it("cancels a pending history load when closing the chat", async () => {
    const { getSignal } = mockAbortableFetch();
    const { result } = renderHook(() => useAiChat({ projectId: "project-1" }));

    let selection!: Promise<void>;
    act(() => {
      selection = result.current.handleSelectSession(session("session-a"));
    });
    act(() => result.current.handleClose());
    await act(async () => selection);

    expect(getSignal()?.aborted).toBe(true);
    expect(result.current.currentSessionId).toBeNull();
  });

  it("cancels a pending history load when deleting the active session", async () => {
    const { getSignal } = mockAbortableFetch();
    const { result } = renderHook(() => useAiChat({ projectId: "project-1" }));

    let selection!: Promise<void>;
    act(() => {
      selection = result.current.handleSelectSession(session("session-a"));
    });
    act(() => result.current.handleDeleteSession("session-a"));
    await act(async () => selection);

    expect(getSignal()?.aborted).toBe(true);
    expect(result.current.currentSessionId).toBeNull();
  });

  it("logs non-abort failures while loading session history", async () => {
    const error = new Error("network unavailable");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { result } = renderHook(() => useAiChat({ projectId: "project-1" }));

    await act(async () => result.current.handleSelectSession(session("session-a")));

    expect(consoleError).toHaveBeenCalledWith("[AI Chat] Failed to load session messages:", error);
  });
});

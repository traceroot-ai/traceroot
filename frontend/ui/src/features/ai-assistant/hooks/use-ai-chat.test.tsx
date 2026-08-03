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
});

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
});

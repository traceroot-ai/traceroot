// @vitest-environment jsdom
import { useEffect } from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";
import { useAiChat } from "./use-ai-chat";
import type { AISession } from "../types";
import type { ModelSelection } from "../components/model-selector";

function createSSE() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const encoder = new TextEncoder();
  return {
    response: new Response(stream, { status: 200 }),
    emit(delta: string) {
      try {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", delta },
            })}\n`,
          ),
        );
      } catch {
        // stream cancelled — assertions read hook state
      }
    },
    close() {
      try {
        controller.close();
      } catch {
        // already cancelled
      }
    },
  };
}

const MODEL: ModelSelection = {
  model: "test-model",
  provider: "test-provider",
  source: "system",
  adapter: "anthropic",
};

const sessionB: AISession = {
  id: "B",
  projectId: "p1",
  title: "older chat",
  status: "active",
  createTime: "2026-01-01T00:00:00Z",
};

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

describe("useAiChat session switching", () => {
  let sseA: ReturnType<typeof createSSE>;
  let fetchMock: ReturnType<typeof vi.fn>;
  /** GET .../sessions/<id>/messages calls, by session id */
  let historyFetches: string[];

  beforeEach(() => {
    sseA = createSSE();
    historyFetches = [];
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "POST" && url.endsWith("/ai/sessions")) {
        return jsonResponse({ id: "A" });
      }
      if (method === "POST" && url.endsWith("/ai/sessions/A/messages")) {
        return sseA.response;
      }
      const historyMatch = url.match(/\/ai\/sessions\/([^/]+)\/messages$/);
      if (method === "GET" && historyMatch) {
        historyFetches.push(historyMatch[1]);
        return jsonResponse({
          messages: [
            {
              id: `${historyMatch[1]}-m1`,
              role: "user",
              content: `history of ${historyMatch[1]}`,
              createTime: "2026-01-01T00:00:00Z",
            },
          ],
        });
      }
      if (method === "GET" && url.endsWith("/ai/sessions")) {
        return jsonResponse({ sessions: [sessionB] });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const renderChat = () => renderHook(() => useAiChat({ projectId: "p1" }));

  const startStreamInA = async (result: ReturnType<typeof renderChat>["result"]) => {
    await act(async () => {
      await result.current.handleSend("hi there", MODEL);
    });
    sseA.emit("partial answer");
    await waitFor(() =>
      expect(result.current.messages.some((m) => m.content === "partial answer")).toBe(true),
    );
  };

  it("keeps a still-streaming session's deltas out of another session's view", async () => {
    const { result } = renderChat();
    await startStreamInA(result);
    expect(result.current.isStreaming).toBe(true);

    await act(async () => {
      await result.current.handleSelectSession(sessionB);
    });
    await waitFor(() =>
      expect(result.current.messages.some((m) => m.content === "history of B")).toBe(true),
    );

    // session A's stream keeps producing — nothing may bleed into B's view
    sseA.emit(" continues");
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.messages.every((m) => !m.content.includes("continues"))).toBe(true);
    // and the visible session is not "streaming"
    expect(result.current.isStreaming).toBe(false);
  });

  it("returning to a still-streaming session shows its accumulated progress without a history fetch", async () => {
    const { result } = renderChat();
    await startStreamInA(result);

    await act(async () => {
      await result.current.handleSelectSession(sessionB);
    });
    sseA.emit(" and more");

    await act(async () => {
      await result.current.handleSelectSession({ ...sessionB, id: "A" });
    });

    // live bucket is shown as-is: user turn + partial assistant text
    await waitFor(() =>
      expect(result.current.messages.some((m) => m.content === "partial answer and more")).toBe(
        true,
      ),
    );
    expect(result.current.messages.some((m) => m.content === "hi there")).toBe(true);
    expect(result.current.isStreaming).toBe(true);
    // the DB (which lacks the in-flight response) must not have been consulted
    expect(historyFetches).not.toContain("A");
  });

  it("handleNewSession empties the view but leaves the previous stream running", async () => {
    const { result } = renderChat();
    await startStreamInA(result);

    act(() => {
      result.current.handleNewSession();
    });
    expect(result.current.messages).toEqual([]);
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.currentSessionId).toBeNull();

    // stream A still accumulates in the background
    sseA.emit(" background");
    await act(async () => {
      await result.current.handleSelectSession({ ...sessionB, id: "A" });
    });
    await waitFor(() =>
      expect(result.current.messages.some((m) => m.content === "partial answer background")).toBe(
        true,
      ),
    );
  });

  it("handleClose aborts every stream and clears all cached sessions", async () => {
    const { result } = renderChat();
    await startStreamInA(result);

    act(() => {
      result.current.handleClose();
    });
    expect(result.current.messages).toEqual([]);
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.currentSessionId).toBeNull();

    // late chunks are dropped: revisiting A hits the DB, not a live bucket
    sseA.emit(" ghost");
    await act(async () => {
      await result.current.handleSelectSession({ ...sessionB, id: "A" });
    });
    await waitFor(() => expect(historyFetches).toContain("A"));
    expect(result.current.messages.every((m) => !m.content.includes("ghost"))).toBe(true);
  });

  it("a history load resolving after a send does not clobber the live run", async () => {
    const { result } = renderChat();
    const sseB = createSSE();
    let resolveHistory!: (r: Response) => void;
    const deferredHistory = new Promise<Response>((r) => {
      resolveHistory = r;
    });
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "GET" && url.endsWith("/ai/sessions/B/messages")) return deferredHistory;
      if (method === "POST" && url.endsWith("/ai/sessions/B/messages")) return sseB.response;
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    // select B — its history fetch stays in flight
    let selectPromise!: Promise<void>;
    act(() => {
      selectPromise = result.current.handleSelectSession(sessionB);
    });
    // user sends a message in B before the history load resolves
    await act(async () => {
      await result.current.handleSend("fresh question", MODEL);
    });
    sseB.emit("live reply");
    await waitFor(() =>
      expect(result.current.messages.some((m) => m.content === "live reply")).toBe(true),
    );

    // the stale history resolves now — it must not wipe the live run
    resolveHistory(
      new Response(
        JSON.stringify({
          messages: [
            {
              id: "b-old",
              role: "user",
              content: "history of B",
              createTime: "2026-01-01T00:00:00Z",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await act(async () => {
      await selectPromise;
    });

    expect(result.current.messages.some((m) => m.content === "fresh question")).toBe(true);
    expect(result.current.messages.some((m) => m.content === "live reply")).toBe(true);
    expect(result.current.isStreaming).toBe(true);
  });

  it("a second send right after session creation reuses the session", async () => {
    let sessionPosts = 0;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "POST" && url.endsWith("/ai/sessions")) {
        sessionPosts += 1;
        return jsonResponse({ id: "A" });
      }
      if (method === "POST" && url.endsWith("/ai/sessions/A/messages")) {
        return createSSE().response;
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    const { result } = renderChat();

    await act(async () => {
      await result.current.handleSend("one", MODEL);
      // fired before any rerender can commit the new session id to state
      await result.current.handleSend("two", MODEL);
    });

    expect(sessionPosts).toBe(1);
  });

  it("deleting the active session clears the view and stops its stream", async () => {
    const { result } = renderChat();
    await startStreamInA(result);

    act(() => {
      result.current.handleDeleteSession("A");
    });
    expect(result.current.messages).toEqual([]);
    expect(result.current.currentSessionId).toBeNull();
    expect(result.current.isStreaming).toBe(false);
  });
});

const PICK = { model: "kimi-k3", provider: "Moonshot", source: "byok" as const, adapter: "openai" };

describe("useAiChat model selection", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

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

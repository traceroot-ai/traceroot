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

  it("concurrent sends share one in-flight session creation", async () => {
    let sessionPosts = 0;
    const messagePosts: string[] = [];
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "POST" && url.endsWith("/ai/sessions")) {
        sessionPosts += 1;
        return jsonResponse({ id: "A" });
      }
      const messageMatch = url.match(/\/ai\/sessions\/([^/]+)\/messages$/);
      if (method === "POST" && messageMatch) {
        messagePosts.push(messageMatch[1]);
        return createSSE().response;
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    const { result } = renderChat();

    // both fired before the first creation resolves — they must share it
    await act(async () => {
      await Promise.all([
        result.current.handleSend("one", MODEL),
        result.current.handleSend("two", MODEL),
      ]);
    });

    expect(sessionPosts).toBe(1);
    expect(messagePosts).toEqual(["A", "A"]);
  });

  it("a project switch discards an in-flight session creation", async () => {
    const sessionPosts: string[] = [];
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const createMatch = url.match(/\/api\/projects\/([^/]+)\/ai\/sessions$/);
      if (method === "POST" && createMatch) {
        sessionPosts.push(createMatch[1]);
        if (createMatch[1] === "p1") {
          // never resolves on its own — only the abort settles it
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          });
        }
        return jsonResponse({ id: "B-session" });
      }
      const messageMatch = url.match(/\/ai\/sessions\/([^/]+)\/messages$/);
      if (method === "POST" && messageMatch) return createSSE().response;
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    const { result, rerender } = renderHook(({ projectId }) => useAiChat({ projectId }), {
      initialProps: { projectId: "p1" },
    });

    // p1's creation is still in flight when the user switches projects
    let firstSend!: Promise<void>;
    act(() => {
      firstSend = result.current.handleSend("hi", MODEL);
    });
    rerender({ projectId: "p2" });

    await act(async () => {
      await result.current.handleSend("hello", MODEL);
      await firstSend;
    });

    // p2 got its own session; the aborted p1 creation never leaked in
    expect(sessionPosts).toEqual(["p1", "p2"]);
    expect(result.current.currentSessionId).toBe("B-session");
  });

  it("closing the panel drops a send whose creation resolved across the close", async () => {
    let resolveCreation!: (r: Response) => void;
    const messagePosts: string[] = [];
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "POST" && url.endsWith("/ai/sessions")) {
        // settles only via resolveCreation — deliberately ignores the abort
        // signal, modeling a response that was already on the wire at close
        return new Promise<Response>((r) => {
          resolveCreation = r;
        });
      }
      const messageMatch = url.match(/\/ai\/sessions\/([^/]+)\/messages$/);
      if (method === "POST" && messageMatch) {
        messagePosts.push(messageMatch[1]);
        return createSSE().response;
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    const { result } = renderChat();

    let send!: Promise<void>;
    act(() => {
      send = result.current.handleSend("hi", MODEL);
    });
    act(() => {
      result.current.handleClose();
    });
    // the creation succeeds anyway — but the panel is closed: no run may start
    resolveCreation(jsonResponse({ id: "A" }));
    await act(async () => {
      await send;
    });

    expect(messagePosts).toEqual([]);
    expect(result.current.currentSessionId).toBeNull();
  });

  it("a send after close-and-reopen starts a fresh session instead of reusing the pre-close creation", async () => {
    const creations: Array<(r: Response) => void> = [];
    const messagePosts: string[] = [];
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "POST" && url.endsWith("/ai/sessions")) {
        // deliberately ignores the abort signal — the pre-close creation's
        // response is already on the wire and settles late
        return new Promise<Response>((r) => {
          creations.push(r);
        });
      }
      const messageMatch = url.match(/\/ai\/sessions\/([^/]+)\/messages$/);
      if (method === "POST" && messageMatch) {
        messagePosts.push(messageMatch[1]);
        return createSSE().response;
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    const { result } = renderChat();

    let first!: Promise<void>;
    act(() => {
      first = result.current.handleSend("pre-close", MODEL);
    });
    act(() => {
      result.current.handleClose();
    });

    // the user reopens the panel and starts a new conversation
    let second!: Promise<void>;
    act(() => {
      second = result.current.handleSend("post-reopen", MODEL);
    });

    // the post-reopen send must not ride the pre-close creation
    expect(creations).toHaveLength(2);

    await act(async () => {
      creations[1](jsonResponse({ id: "B" }));
      await second;
      creations[0](jsonResponse({ id: "A" }));
      await first;
    });

    // the reopened chat runs in its own session; the pre-close send stays dropped
    expect(messagePosts).toEqual(["B"]);
    expect(result.current.currentSessionId).toBe("B");
  });

  it("a pre-close send settling does not blank the waiting state of a post-reopen send", async () => {
    const creations: Array<(r: Response) => void> = [];
    const messagePosts: string[] = [];
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "POST" && url.endsWith("/ai/sessions")) {
        return new Promise<Response>((r) => {
          creations.push(r);
        });
      }
      const messageMatch = url.match(/\/ai\/sessions\/([^/]+)\/messages$/);
      if (method === "POST" && messageMatch) {
        messagePosts.push(messageMatch[1]);
        return createSSE().response;
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    const { result } = renderChat();

    let first!: Promise<void>;
    act(() => {
      first = result.current.handleSend("pre-close", MODEL);
    });
    act(() => {
      result.current.handleClose();
    });
    let second!: Promise<void>;
    act(() => {
      second = result.current.handleSend("post-reopen", MODEL);
    });

    // the pre-close creation settles (and its send winds down) while the
    // post-reopen send is still waiting on its own creation
    await act(async () => {
      creations[0](jsonResponse({ id: "A" }));
      await first;
    });

    // the panel must still show as busy — one send is genuinely in flight
    expect(result.current.isStreaming).toBe(true);

    await act(async () => {
      creations[1](jsonResponse({ id: "B" }));
      await second;
    });
    expect(messagePosts).toEqual(["B"]);
  });

  it("clicking New Session while a session creation is in flight does not restore the old session", async () => {
    let resolveCreation!: (r: Response) => void;
    const messagePosts: string[] = [];
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "POST" && url.endsWith("/ai/sessions")) {
        return new Promise<Response>((r) => {
          resolveCreation = r;
        });
      }
      const messageMatch = url.match(/\/ai\/sessions\/([^/]+)\/messages$/);
      if (method === "POST" && messageMatch) {
        messagePosts.push(messageMatch[1]);
        return createSSE().response;
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    const { result } = renderChat();

    let send!: Promise<void>;
    act(() => {
      send = result.current.handleSend("hi", MODEL);
    });
    act(() => {
      result.current.handleNewSession();
    });
    await act(async () => {
      resolveCreation(jsonResponse({ id: "A" }));
      await send;
    });

    // the in-flight message still delivers to the session created for it…
    expect(messagePosts).toEqual(["A"]);
    // …but it must not snap the panel back to that session
    expect(result.current.currentSessionId).toBeNull();
    expect(result.current.messages).toEqual([]);
  });

  it("a send after New Session creates a fresh session instead of reusing the pending creation", async () => {
    const creations: Array<(r: Response) => void> = [];
    const messagePosts: string[] = [];
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "POST" && url.endsWith("/ai/sessions")) {
        return new Promise<Response>((r) => {
          creations.push(r);
        });
      }
      const messageMatch = url.match(/\/ai\/sessions\/([^/]+)\/messages$/);
      if (method === "POST" && messageMatch) {
        messagePosts.push(messageMatch[1]);
        return createSSE().response;
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    const { result } = renderChat();

    let first!: Promise<void>;
    act(() => {
      first = result.current.handleSend("one", MODEL);
    });
    act(() => {
      result.current.handleNewSession();
    });
    let second!: Promise<void>;
    act(() => {
      second = result.current.handleSend("two", MODEL);
    });

    // the post-boundary send must have started its own creation
    expect(creations).toHaveLength(2);

    await act(async () => {
      creations[1](jsonResponse({ id: "B" }));
      await second;
      creations[0](jsonResponse({ id: "A" }));
      await first;
    });

    expect(messagePosts).toEqual(["B", "A"]);
    expect(result.current.currentSessionId).toBe("B");
  });

  it("selecting a history session while a creation is in flight is not clobbered by its late commit", async () => {
    let resolveCreation!: (r: Response) => void;
    const messagePosts: string[] = [];
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "POST" && url.endsWith("/ai/sessions")) {
        return new Promise<Response>((r) => {
          resolveCreation = r;
        });
      }
      const messageMatch = url.match(/\/ai\/sessions\/([^/]+)\/messages$/);
      if (method === "POST" && messageMatch) {
        messagePosts.push(messageMatch[1]);
        return createSSE().response;
      }
      if (method === "GET" && messageMatch) return jsonResponse({ messages: [] });
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    const { result } = renderChat();

    let send!: Promise<void>;
    act(() => {
      send = result.current.handleSend("hi", MODEL);
    });
    await act(async () => {
      await result.current.handleSelectSession(sessionB);
    });
    await act(async () => {
      resolveCreation(jsonResponse({ id: "A" }));
      await send;
    });

    expect(messagePosts).toEqual(["A"]);
    expect(result.current.currentSessionId).toBe("B");
  });

  it("an RCA session arriving via initialSessionId is not clobbered by an in-flight creation's commit", async () => {
    let resolveCreation!: (r: Response) => void;
    const messagePosts: string[] = [];
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "POST" && url.endsWith("/ai/sessions")) {
        return new Promise<Response>((r) => {
          resolveCreation = r;
        });
      }
      const messageMatch = url.match(/\/ai\/sessions\/([^/]+)\/messages$/);
      if (method === "POST" && messageMatch) {
        messagePosts.push(messageMatch[1]);
        return createSSE().response;
      }
      if (method === "GET" && messageMatch) return jsonResponse({ messages: [] });
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    const { result, rerender } = renderHook(
      ({ initialSessionId }: { initialSessionId?: string }) =>
        useAiChat({ projectId: "p1", initialSessionId }),
      { initialProps: {} as { initialSessionId?: string } },
    );

    let send!: Promise<void>;
    act(() => {
      send = result.current.handleSend("hi", MODEL);
    });
    // the RCA session arrives while the creation is still in flight
    await act(async () => {
      rerender({ initialSessionId: "R" });
    });
    expect(result.current.currentSessionId).toBe("R");

    await act(async () => {
      resolveCreation(jsonResponse({ id: "A" }));
      await send;
    });

    expect(messagePosts).toEqual(["A"]);
    expect(result.current.currentSessionId).toBe("R");
  });

  it("a send immediately after New Session does not reuse the previous active session", async () => {
    let sessionPosts = 0;
    const messagePosts: string[] = [];
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "POST" && url.endsWith("/ai/sessions")) {
        sessionPosts += 1;
        return jsonResponse({ id: `S${sessionPosts}` });
      }
      const messageMatch = url.match(/\/ai\/sessions\/([^/]+)\/messages$/);
      if (method === "POST" && messageMatch) {
        messagePosts.push(messageMatch[1]);
        return createSSE().response;
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    const { result } = renderChat();

    // establish an active session the normal way
    await act(async () => {
      await result.current.handleSend("old chat", MODEL);
    });
    expect(result.current.currentSessionId).toBe("S1");

    // New Session and a send in the same tick — before any rerender can sync refs
    await act(async () => {
      result.current.handleNewSession();
      await result.current.handleSend("fresh chat", MODEL);
    });

    expect(sessionPosts).toBe(2);
    expect(messagePosts).toEqual(["S1", "S2"]);
    expect(result.current.currentSessionId).toBe("S2");
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

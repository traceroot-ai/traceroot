// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";
import { useAIStream } from "./use-ai-stream";
import type { AIMessage } from "../types";

/**
 * Controllable SSE response: emit() pushes one `data:` line, close() ends the
 * stream. enqueue after cancellation throws inside the helper and is
 * swallowed — the assertion that matters is what landed in the hook state.
 */
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
    emit(event: Record<string, unknown>) {
      try {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n`));
      } catch {
        // stream already cancelled — fine, tests assert on hook state
      }
    },
    /** Push a NAMED SSE event (`event: name` + `data:`), like the agent's final trace event. */
    emitNamed(name: string, data: Record<string, unknown>) {
      try {
        controller.enqueue(encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`));
      } catch {
        // stream already cancelled
      }
    },
    /** Push raw wire text, for malformed or partial SSE frames. */
    emitRaw(text: string) {
      try {
        controller.enqueue(encoder.encode(text));
      } catch {
        // stream already cancelled
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

const textDelta = (delta: string) => ({
  type: "message_update",
  assistantMessageEvent: { type: "text_delta", delta },
});

const historyMsg = (id: string, content: string): AIMessage => ({
  id,
  role: "user",
  content,
  timestamp: "2026-01-01T00:00:00Z",
});

describe("useAIStream per-session isolation", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const send = (result: { current: ReturnType<typeof useAIStream> }, sessionId: string) =>
    act(() => {
      void result.current.sendMessage({
        sessionId,
        message: `hi ${sessionId}`,
        projectId: "p1",
      });
    });

  it("routes stream deltas to the session that started the run, not the visible one", async () => {
    const sseA = createSSE();
    fetchMock.mockResolvedValueOnce(sseA.response);
    const { result } = renderHook(() => useAIStream());

    await send(result, "A");
    await waitFor(() => expect(result.current.messagesBySession["A"]).toHaveLength(1));

    // user "switches" to session B: its history is loaded into B's bucket
    act(() => {
      result.current.setSessionMessages("B", [historyMsg("b1", "old B message")]);
    });

    sseA.emit(textDelta("Hello"));
    sseA.emit(textDelta(" world"));

    await waitFor(() => {
      const a = result.current.messagesBySession["A"];
      expect(a?.some((m) => m.role === "assistant" && m.content === "Hello world")).toBe(true);
    });

    // B's bucket is untouched by A's stream
    expect(result.current.messagesBySession["B"]).toHaveLength(1);
    expect(result.current.messagesBySession["B"]![0].content).toBe("old B message");
  });

  it("keeps session A streaming when a send starts in session B", async () => {
    const sseA = createSSE();
    const sseB = createSSE();
    fetchMock.mockResolvedValueOnce(sseA.response).mockResolvedValueOnce(sseB.response);
    const { result } = renderHook(() => useAIStream());

    await send(result, "A");
    await send(result, "B");
    await waitFor(() => {
      expect(result.current.streamingSessions["A"]).toBe(true);
      expect(result.current.streamingSessions["B"]).toBe(true);
    });

    sseA.emit(textDelta("from A"));
    sseB.emit(textDelta("from B"));

    await waitFor(() => {
      expect(result.current.messagesBySession["A"]?.some((m) => m.content === "from A")).toBe(true);
      expect(result.current.messagesBySession["B"]?.some((m) => m.content === "from B")).toBe(true);
    });

    sseA.close();
    await waitFor(() => expect(result.current.streamingSessions["A"]).toBeFalsy());
    expect(result.current.streamingSessions["B"]).toBe(true);
  });

  it("cancels the prior run when a new send starts in the same session", async () => {
    const sse1 = createSSE();
    const sse2 = createSSE();
    fetchMock.mockResolvedValueOnce(sse1.response).mockResolvedValueOnce(sse2.response);
    const { result } = renderHook(() => useAIStream());

    await send(result, "A");
    sse1.emit(textDelta("one"));
    await waitFor(() =>
      expect(result.current.messagesBySession["A"]?.some((m) => m.content === "one")).toBe(true),
    );

    await send(result, "A");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    // late chunks from the superseded run must not land anywhere
    sse1.emit(textDelta("LEAK"));
    sse2.emit(textDelta("two"));
    await waitFor(() =>
      expect(result.current.messagesBySession["A"]?.some((m) => m.content === "two")).toBe(true),
    );
    expect(result.current.messagesBySession["A"]?.some((m) => m.content.includes("LEAK"))).toBe(
      false,
    );
    // the superseded run's bubble is frozen, not left streaming forever
    expect(
      result.current.messagesBySession["A"]?.filter((m) => m.isStreaming).length,
    ).toBeLessThanOrEqual(1);
  });

  it("abortSession stops only that session's stream", async () => {
    const sseA = createSSE();
    const sseB = createSSE();
    fetchMock.mockResolvedValueOnce(sseA.response).mockResolvedValueOnce(sseB.response);
    const { result } = renderHook(() => useAIStream());

    await send(result, "A");
    await send(result, "B");
    await waitFor(() => {
      expect(result.current.streamingSessions["A"]).toBe(true);
      expect(result.current.streamingSessions["B"]).toBe(true);
    });

    act(() => {
      result.current.abortSession("A");
    });
    await waitFor(() => expect(result.current.streamingSessions["A"]).toBeFalsy());
    expect(result.current.streamingSessions["B"]).toBe(true);

    // aborted stream's late chunks are dropped; B still receives
    sseA.emit(textDelta("ghost"));
    sseB.emit(textDelta("alive"));
    await waitFor(() =>
      expect(result.current.messagesBySession["B"]?.some((m) => m.content === "alive")).toBe(true),
    );
    expect(
      result.current.messagesBySession["A"]?.some((m) => m.content.includes("ghost")),
    ).toBeFalsy();
    // no bubble left permanently streaming in the aborted session
    expect(result.current.messagesBySession["A"]?.some((m) => m.isStreaming)).toBeFalsy();
  });

  it("abortAll stops every stream and clearAll drops every bucket", async () => {
    const sseA = createSSE();
    const sseB = createSSE();
    fetchMock.mockResolvedValueOnce(sseA.response).mockResolvedValueOnce(sseB.response);
    const { result } = renderHook(() => useAIStream());

    await send(result, "A");
    await send(result, "B");
    await waitFor(() => {
      expect(result.current.streamingSessions["A"]).toBe(true);
      expect(result.current.streamingSessions["B"]).toBe(true);
    });

    act(() => {
      result.current.abortAll();
      result.current.clearAll();
    });

    await waitFor(() => {
      expect(result.current.streamingSessions).toEqual({});
      expect(result.current.messagesBySession).toEqual({});
    });
  });

  it("setSessionMessages replaces the bucket of a non-streaming session", () => {
    const { result } = renderHook(() => useAIStream());
    act(() => {
      result.current.setSessionMessages("C", [historyMsg("c1", "one"), historyMsg("c2", "two")]);
    });
    expect(result.current.messagesBySession["C"]).toHaveLength(2);
    act(() => {
      result.current.setSessionMessages("C", [historyMsg("c3", "three")]);
    });
    expect(result.current.messagesBySession["C"]).toHaveLength(1);
    expect(result.current.messagesBySession["C"]![0].content).toBe("three");
  });
});

describe("final trace event annotation", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("annotates the live assistant message with traceId/traceStatus so View trace appears without a reload", async () => {
    const sse = createSSE();
    fetchMock.mockResolvedValueOnce(sse.response);
    const { result } = renderHook(() => useAIStream());
    act(() => {
      void result.current.sendMessage({ sessionId: "T", message: "hi", projectId: "p1" });
    });

    sse.emit(textDelta("answer"));
    sse.emitNamed("trace", { status: "available", traceId: "abc123" });
    sse.close();

    await waitFor(() => {
      const msgs = result.current.messagesBySession["T"];
      const assistant = msgs?.find((m) => m.role === "assistant");
      expect(assistant?.traceId).toBe("abc123");
      expect(assistant?.traceStatus).toBe("available");
    });
  });

  it("leaves the message unannotated when tracing was disabled for the run", async () => {
    const sse = createSSE();
    fetchMock.mockResolvedValueOnce(sse.response);
    const { result } = renderHook(() => useAIStream());
    act(() => {
      void result.current.sendMessage({ sessionId: "T2", message: "hi", projectId: "p1" });
    });

    sse.emit(textDelta("answer"));
    sse.emitNamed("trace", { status: "disabled", traceId: "abc123" });
    sse.close();

    // Wait for the stream to END, not just for the text delta: the trace event
    // is a separately enqueued chunk, so asserting after the delta alone would
    // pass whether or not the disabled event was consumed. streamingSessions
    // only goes falsy in the hook's finally, after the read loop has drained.
    await waitFor(() => {
      expect(result.current.streamingSessions["T2"]).toBeFalsy();
    });
    const assistant = result.current.messagesBySession["T2"]!.find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("answer");
    expect(assistant?.traceId).toBeUndefined();
  });

  it("scopes an event name to its own frame: a dataless or non-JSON named event never swallows the next data line", async () => {
    const sse = createSSE();
    fetchMock.mockResolvedValueOnce(sse.response);
    const { result } = renderHook(() => useAIStream());
    act(() => {
      void result.current.sendMessage({ sessionId: "T3", message: "hi", projectId: "p1" });
    });

    // A named event with no data line, closed by the blank line. With the
    // name left set, the delta that follows was read as the trace payload
    // and dropped.
    sse.emitRaw("event: trace\n\n");
    sse.emit(textDelta("first"));
    // A named event whose data is not JSON (the agent's `event: error` can
    // carry a raw string): the parse failure must still consume the name.
    sse.emitRaw("event: trace\ndata: not json\n\n");
    sse.emit(textDelta(" second"));
    sse.close();

    await waitFor(() => {
      expect(result.current.streamingSessions["T3"]).toBeFalsy();
    });
    const assistant = result.current.messagesBySession["T3"]!.find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("first second");
    expect(assistant?.traceId).toBeUndefined();
  });
});

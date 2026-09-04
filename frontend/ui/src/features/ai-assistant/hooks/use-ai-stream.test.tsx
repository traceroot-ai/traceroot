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
    /** Push a raw SSE line (e.g. a `:` heartbeat comment) untouched. */
    emitRaw(line: string) {
      try {
        controller.enqueue(encoder.encode(`${line}\n`));
      } catch {
        // stream already cancelled — fine, tests assert on hook state
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

const toolEndEvent = {
  type: "tool_execution_end",
  toolCallId: "tc1",
  toolName: "create_dashboard",
  result: {
    content: [{ type: "text", text: 'Created dashboard "Spend" (id db1)' }],
    details: { kind: "resource_created", resourceType: "dashboard", resourceId: "db1" },
  },
  isError: false,
};

const sendParams = { sessionId: "s1", message: "make a dashboard", projectId: "p1" };

describe("useAIStream live tool-result and turn-completion callbacks", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  /** Start a run in s1 against `sse` without awaiting it; returns its promise. */
  const startSend = (
    result: { current: ReturnType<typeof useAIStream> },
    sse: ReturnType<typeof createSSE>,
  ) => {
    fetchMock.mockResolvedValueOnce(sse.response);
    let send!: Promise<void>;
    act(() => {
      send = result.current.sendMessage(sendParams);
    });
    return send;
  };

  it("reports live tool results with the run's session and project", async () => {
    const sse = createSSE();
    const onToolResult = vi.fn();
    const { result } = renderHook(() => useAIStream({ onToolResult }));
    const send = startSend(result, sse);

    sse.emit(toolEndEvent);
    sse.close();
    await act(() => send);

    expect(onToolResult).toHaveBeenCalledExactlyOnceWith({
      sessionId: "s1",
      projectId: "p1",
      result: toolEndEvent.result,
      isError: false,
    });
  });

  it("still records the tool step when no callback is given", async () => {
    const sse = createSSE();
    const { result } = renderHook(() => useAIStream());
    const send = startSend(result, sse);

    sse.emit({ type: "tool_execution_start", toolCallId: "tc1", toolName: "create_dashboard" });
    sse.emit(toolEndEvent);
    sse.close();
    await act(() => send);

    const step = result.current.messagesBySession["s1"]?.find((m) => m.role === "tool_step");
    expect(step?.toolStep?.result).toEqual(toolEndEvent.result);
    expect(step?.toolStep?.status).toBe("done");
  });

  it("fires onTurnComplete once, after the turn's tool results, on a normal drain", async () => {
    const sse = createSSE();
    const onToolResult = vi.fn();
    const onTurnComplete = vi.fn();
    const { result } = renderHook(() => useAIStream({ onToolResult, onTurnComplete }));
    const send = startSend(result, sse);

    sse.emit(toolEndEvent);
    sse.emit(textDelta("done"));
    sse.close();
    await act(() => send);

    expect(onTurnComplete).toHaveBeenCalledExactlyOnceWith({ sessionId: "s1", projectId: "p1" });
    expect(onTurnComplete.mock.invocationCallOrder[0]).toBeGreaterThan(
      onToolResult.mock.invocationCallOrder[0],
    );
  });

  it("does not fire onTurnComplete when the run is aborted mid-turn", async () => {
    const sse = createSSE();
    const onTurnComplete = vi.fn();
    const { result } = renderHook(() => useAIStream({ onTurnComplete }));
    const send = startSend(result, sse);
    await waitFor(() => expect(result.current.streamingSessions["s1"]).toBe(true));

    act(() => {
      result.current.abortSession("s1");
    });
    sse.close();
    await act(() => send);

    expect(onTurnComplete).not.toHaveBeenCalled();
  });

  it("reports neither callback for a run superseded within its own session", async () => {
    const superseded = createSSE();
    const winner = createSSE();
    const onToolResult = vi.fn();
    const onTurnComplete = vi.fn();
    const { result } = renderHook(() => useAIStream({ onToolResult, onTurnComplete }));
    const first = startSend(result, superseded);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // A second send in the SAME session cancels the first run.
    const second = startSend(result, winner);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    // The dead run's tool result arrives late — it must be ignored entirely.
    superseded.emit(toolEndEvent);
    superseded.close();
    winner.close();
    await act(async () => {
      await Promise.all([first, second]);
    });

    expect(onToolResult).not.toHaveBeenCalled();
    // Only the run that still owns the session reports completion.
    expect(onTurnComplete).toHaveBeenCalledExactlyOnceWith({ sessionId: "s1", projectId: "p1" });
  });

  it("does not fire onTurnComplete when the turn surfaces a stream error event", async () => {
    const sse = createSSE();
    const onTurnComplete = vi.fn();
    const { result } = renderHook(() => useAIStream({ onTurnComplete }));
    const send = startSend(result, sse);

    sse.emit(toolEndEvent);
    sse.emit({ type: "error", message: "boom" });
    sse.close();
    await act(() => send);

    expect(onTurnComplete).not.toHaveBeenCalled();
  });

  it("keeps the partial answer when a stream error interrupts the bubble", async () => {
    // The persisted transcript keeps whatever the assistant already said, so a
    // live bubble that replaced it with the error alone would not survive a
    // reload of the same session.
    const sse = createSSE();
    const { result } = renderHook(() => useAIStream());
    const send = startSend(result, sse);

    sse.emit(textDelta("Half an answer"));
    sse.emit({ type: "error", message: "boom" });
    sse.close();
    await act(() => send);

    const assistant = result.current.messagesBySession["s1"]?.find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("Half an answer\n\nError: boom");
  });

  it("opens a bubble with the error alone when nothing had streamed yet", async () => {
    const sse = createSSE();
    const { result } = renderHook(() => useAIStream());
    const send = startSend(result, sse);

    sse.emit({ type: "error", message: "boom" });
    sse.close();
    await act(() => send);

    const assistant = result.current.messagesBySession["s1"]?.find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("Error: boom");
  });

  it("does not fire onTurnComplete when the turn ends with an errored message_end", async () => {
    const sse = createSSE();
    const onTurnComplete = vi.fn();
    const { result } = renderHook(() => useAIStream({ onTurnComplete }));
    const send = startSend(result, sse);

    sse.emit({
      type: "message_end",
      message: { stopReason: "error", errorMessage: "model failed" },
    });
    sse.close();
    await act(() => send);

    expect(onTurnComplete).not.toHaveBeenCalled();
  });
});

describe("useAIStream confirmation_pending", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const startSend = (
    result: { current: ReturnType<typeof useAIStream> },
    sse: ReturnType<typeof createSSE>,
  ) => {
    fetchMock.mockResolvedValueOnce(sse.response);
    let send!: Promise<void>;
    act(() => {
      send = result.current.sendMessage({ sessionId: "s1", message: "make it", projectId: "p1" });
    });
    return send;
  };

  const toolStart = {
    type: "tool_execution_start",
    toolCallId: "tc1",
    toolName: "create_widget",
    args: { title: "Tokens" },
  };
  const pendingEvent = (decisionId: string) => ({
    type: "confirmation_pending",
    decisionId,
    toolCallId: "tc1",
    toolName: "create_widget",
    args: { title: "Tokens" },
  });
  const findStep = (result: { current: ReturnType<typeof useAIStream> }) =>
    result.current.messagesBySession["s1"]?.find((m) => m.role === "tool_step")?.toolStep;

  it("marks the running tool step pending with its decision id", async () => {
    const sse = createSSE();
    const { result } = renderHook(() => useAIStream());
    startSend(result, sse);

    sse.emit(toolStart);
    sse.emit(pendingEvent("d1"));

    await waitFor(() => expect(findStep(result)?.pending).toEqual({ decisionId: "d1" }));
    expect(findStep(result)?.status).toBe("running");
    const steps = result.current.messagesBySession["s1"]!.filter((m) => m.role === "tool_step");
    expect(steps).toHaveLength(1);
  });

  it("replaces the pending entry in place on a second event for the same call", async () => {
    const sse = createSSE();
    const { result } = renderHook(() => useAIStream());
    startSend(result, sse);

    sse.emit(toolStart);
    sse.emit(pendingEvent("d1"));
    sse.emit(pendingEvent("d2"));

    await waitFor(() => expect(findStep(result)?.pending).toEqual({ decisionId: "d2" }));
    const steps = result.current.messagesBySession["s1"]!.filter((m) => m.role === "tool_step");
    expect(steps).toHaveLength(1);
  });

  it("appends a pending tool step when no start event preceded it", async () => {
    const sse = createSSE();
    const { result } = renderHook(() => useAIStream());
    startSend(result, sse);

    sse.emit(pendingEvent("d1"));

    await waitFor(() => expect(findStep(result)?.pending).toEqual({ decisionId: "d1" }));
    expect(findStep(result)?.toolName).toBe("create_widget");
    expect(findStep(result)?.args).toEqual({ title: "Tokens" });
    expect(findStep(result)?.status).toBe("running");
  });

  it("tolerates SSE heartbeat comment lines between events", async () => {
    const sse = createSSE();
    const { result } = renderHook(() => useAIStream());
    startSend(result, sse);

    sse.emit(toolStart);
    sse.emitRaw(": parked, awaiting a decision");
    sse.emit(pendingEvent("d1"));

    await waitFor(() => expect(findStep(result)?.pending).toEqual({ decisionId: "d1" }));
  });

  it("clears pending when the tool result lands, turning the card into the receipt", async () => {
    const sse = createSSE();
    const { result } = renderHook(() => useAIStream());
    startSend(result, sse);

    sse.emit(toolStart);
    sse.emit(pendingEvent("d1"));
    await waitFor(() => expect(findStep(result)?.pending).toBeDefined());

    sse.emit({
      type: "tool_execution_end",
      toolCallId: "tc1",
      toolName: "create_widget",
      result: { content: [{ type: "text", text: "Created" }] },
      isError: false,
    });

    await waitFor(() => expect(findStep(result)?.status).toBe("done"));
    expect(findStep(result)?.pending).toBeUndefined();
    expect(findStep(result)?.skipped).toBeFalsy();
  });

  it("marks a declined result on a still-pending step as skipped", async () => {
    const sse = createSSE();
    const { result } = renderHook(() => useAIStream());
    startSend(result, sse);

    sse.emit(toolStart);
    sse.emit(pendingEvent("d1"));
    await waitFor(() => expect(findStep(result)?.pending).toBeDefined());

    sse.emit({
      type: "tool_execution_end",
      toolCallId: "tc1",
      toolName: "create_widget",
      result: { content: [{ type: "text", text: "The user chose to skip this call." }] },
      isError: true,
    });

    await waitFor(() => expect(findStep(result)?.skipped).toBe(true));
    expect(findStep(result)?.pending).toBeUndefined();
    expect(findStep(result)?.status).toBe("error");
  });

  it("never marks an ordinary tool error as skipped", async () => {
    const sse = createSSE();
    const { result } = renderHook(() => useAIStream());
    startSend(result, sse);

    sse.emit(toolStart);
    sse.emit({
      type: "tool_execution_end",
      toolCallId: "tc1",
      toolName: "create_widget",
      result: { content: [{ type: "text", text: "boom" }] },
      isError: true,
    });

    await waitFor(() => expect(findStep(result)?.status).toBe("error"));
    expect(findStep(result)?.skipped).toBeFalsy();
  });

  it("resolvePendingDecision clears pending on create and marks skip as skipped", async () => {
    const sse = createSSE();
    const { result } = renderHook(() => useAIStream());
    startSend(result, sse);

    sse.emit(toolStart);
    sse.emit(pendingEvent("d1"));
    await waitFor(() => expect(findStep(result)?.pending).toBeDefined());

    act(() => {
      result.current.resolvePendingDecision("s1", "tc1", "create");
    });
    expect(findStep(result)?.pending).toBeUndefined();
    expect(findStep(result)?.skipped).toBeFalsy();

    sse.emit(pendingEvent("d2"));
    await waitFor(() => expect(findStep(result)?.pending).toEqual({ decisionId: "d2" }));

    act(() => {
      result.current.resolvePendingDecision("s1", "tc1", "skip");
    });
    expect(findStep(result)?.pending).toBeUndefined();
    expect(findStep(result)?.skipped).toBe(true);
  });
});

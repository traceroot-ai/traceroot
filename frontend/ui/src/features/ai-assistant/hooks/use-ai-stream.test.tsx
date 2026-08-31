// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAIStream } from "./use-ai-stream";

const encoder = new TextEncoder();

/** Fake streaming Response delivering the given agent events as SSE lines. */
function sseResponse(events: unknown[]) {
  const chunks = events.map((e) => encoder.encode(`data: ${JSON.stringify(e)}\n`));
  let i = 0;
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length
            ? { done: false as const, value: chunks[i++] }
            : { done: true as const, value: undefined },
        cancel: vi.fn(),
      }),
    },
  };
}

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useAIStream onToolResult", () => {
  it("reports live tool results with the stream's session and project", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseResponse([toolEndEvent])),
    );
    const onToolResult = vi.fn();
    const { result } = renderHook(() => useAIStream({ onToolResult }));
    await act(() => result.current.sendMessage(sendParams));
    expect(onToolResult).toHaveBeenCalledTimes(1);
    expect(onToolResult).toHaveBeenCalledWith({
      sessionId: "s1",
      projectId: "p1",
      result: toolEndEvent.result,
      isError: false,
    });
  });

  it("still records the tool step when no callback is given", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          {
            type: "tool_execution_start",
            toolCallId: "tc1",
            toolName: "create_dashboard",
            args: {},
          },
          toolEndEvent,
        ]),
      ),
    );
    const { result } = renderHook(() => useAIStream());
    await act(() => result.current.sendMessage(sendParams));
    const step = result.current.messages.find((m) => m.role === "tool_step");
    expect(step?.toolStep?.result).toEqual(toolEndEvent.result);
    expect(step?.toolStep?.status).toBe("done");
  });

  it("does not report tool results from a superseded stream", async () => {
    // First send's stream stalls until released, then delivers its tool event
    // after a newer send has already taken over.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        if (call === 1) {
          const chunk = encoder.encode(`data: ${JSON.stringify(toolEndEvent)}\n`);
          let delivered = false;
          return {
            ok: true,
            body: {
              getReader: () => ({
                read: async () => {
                  if (!delivered) {
                    await gate;
                    delivered = true;
                    return { done: false as const, value: chunk };
                  }
                  return { done: true as const, value: undefined };
                },
                cancel: vi.fn(),
              }),
            },
          };
        }
        return sseResponse([]);
      }),
    );
    const onToolResult = vi.fn();
    const { result } = renderHook(() => useAIStream({ onToolResult }));
    let first!: Promise<void>;
    act(() => {
      first = result.current.sendMessage(sendParams);
    });
    await act(() => result.current.sendMessage({ ...sendParams, sessionId: "s2" }));
    release();
    await act(() => first);
    expect(onToolResult).not.toHaveBeenCalled();
  });
});

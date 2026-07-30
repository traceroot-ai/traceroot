// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SpanKind, SpanStatus } from "@traceroot/core";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Span, TraceDetail } from "@/types/api";
import { useTraceStream } from "./use-trace-stream";

const TRACE_KEY = ["trace", "project-1", "trace-1"] as const;

type EventSourceListener = (event: MessageEvent<string>) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];

  readonly url: string;
  onerror: ((event: Event) => void) | null = null;
  private listeners = new Map<string, EventSourceListener[]>();
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventSourceListener): void {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(type, [...listeners, listener]);
  }

  emit(type: string, data: unknown = {}): void {
    const event = new MessageEvent<string>(type, {
      data: JSON.stringify(data),
    });

    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  fail(): void {
    this.onerror?.(new Event("error"));
  }
}

function makeSpan(overrides: Partial<Span> & { span_id: string }): Span {
  return {
    span_id: overrides.span_id,
    trace_id: "trace-1",
    parent_span_id: null,
    name: overrides.span_id,
    span_kind: SpanKind.SPAN,
    span_start_time: "2026-07-29T10:00:00.000Z",
    span_end_time: "2026-07-29T10:00:01.000Z",
    status: SpanStatus.OK,
    status_message: null,
    model_name: null,
    cost: null,
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    input: null,
    output: null,
    metadata: null,
    git_source_file: null,
    git_source_line: null,
    git_source_function: null,
    ...overrides,
  };
}

function makeTrace(spans: Span[]): TraceDetail {
  return {
    trace_id: "trace-1",
    project_id: "project-1",
    name: "test trace",
    trace_start_time: "2026-07-29T10:00:00.000Z",
    user_id: null,
    session_id: null,
    git_ref: null,
    git_repo: null,
    environment: "test",
    release: null,
    input: null,
    output: null,
    metadata: null,
    spans,
  };
}

function createHarness() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }

  return {
    queryClient,
    wrapper: Wrapper,
  };
}

beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useTraceStream", () => {
  it("merges span events into the trace cache", () => {
    const { queryClient, wrapper } = createHarness();

    queryClient.setQueryData(
      TRACE_KEY,
      makeTrace([
        makeSpan({
          span_id: "existing",
          input: undefined,
          output: undefined,
          metadata: undefined,
        }),
      ]),
    );

    const { result } = renderHook(() => useTraceStream("project-1", "trace-1", true), { wrapper });
    const eventSource = MockEventSource.instances[0];

    expect(eventSource.url).toBe("/api/projects/project-1/traces/trace-1/live");

    act(() => {
      eventSource.emit("spans", {
        spans: [
          makeSpan({
            span_id: "existing",
            input: "complete input",
          }),
          makeSpan({
            span_id: "new-span",
          }),
        ],
      });
    });

    const cachedTrace = queryClient.getQueryData<TraceDetail>(TRACE_KEY);

    expect(cachedTrace?.spans.filter((span) => span.span_id === "existing")).toHaveLength(1);
    expect(cachedTrace?.spans.find((span) => span.span_id === "existing")?.input).toBe(
      "complete input",
    );
    expect(cachedTrace?.spans.some((span) => span.span_id === "new-span")).toBe(true);
    expect(result.current.isStreaming).toBe(true);
  });

  it("closes and invalidates the trace query when trace_complete arrives", () => {
    const { queryClient, wrapper } = createHarness();
    queryClient.setQueryData(TRACE_KEY, makeTrace([]));
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useTraceStream("project-1", "trace-1", true), { wrapper });
    const eventSource = MockEventSource.instances[0];

    act(() => {
      eventSource.emit("spans", {
        spans: [makeSpan({ span_id: "live-span" })],
      });
    });
    expect(result.current.isStreaming).toBe(true);

    act(() => {
      eventSource.emit("trace_complete");
    });

    expect(result.current.isStreaming).toBe(false);
    expect(eventSource.close).toHaveBeenCalledOnce();
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["trace", "project-1", "trace-1"],
    });
  });

  it("clears streaming state when EventSource reports an error", () => {
    const { queryClient, wrapper } = createHarness();
    queryClient.setQueryData(TRACE_KEY, makeTrace([]));

    const { result } = renderHook(() => useTraceStream("project-1", "trace-1", true), { wrapper });
    const eventSource = MockEventSource.instances[0];

    act(() => {
      eventSource.emit("spans", {
        spans: [makeSpan({ span_id: "live-span" })],
      });
    });
    expect(result.current.isStreaming).toBe(true);

    act(() => {
      eventSource.fail();
    });

    expect(result.current.isStreaming).toBe(false);
    expect(eventSource.close).not.toHaveBeenCalled();
  });

  it("closes the EventSource when the hook unmounts", () => {
    const { wrapper } = createHarness();

    const { unmount } = renderHook(() => useTraceStream("project-1", "trace-1", true), { wrapper });
    const eventSource = MockEventSource.instances[0];

    expect(eventSource.close).not.toHaveBeenCalled();

    act(() => {
      unmount();
    });

    expect(eventSource.close).toHaveBeenCalledOnce();
  });
});

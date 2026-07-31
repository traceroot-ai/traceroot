// @vitest-environment jsdom

/**
 * The stream writes into the trace-detail cache with an exact-hash
 * setQueryData, so the tests use the same source-aware key as the panel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

import type { Span, TraceDetail } from "@/types/api";
import { traceQueryKey } from "./index";
import { useTraceStream } from "./use-trace-stream";

function emit(es: FakeEventSource, type: string, data: unknown): void {
  // EventSource callbacks update React state, so the test must deliver them
  // inside act() just as React would process a browser event.
  act(() => es.emit(type, data));
}

/** jsdom and Node 20 do not provide EventSource, so tests control this fake. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, (event: MessageEvent) => void>();
  closed = false;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.set(type, listener);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: unknown): void {
    this.listeners.get(type)?.({
      data: JSON.stringify(data),
    } as MessageEvent);
  }
}

function span(id: string, extra: Partial<Span> = {}): Span {
  return {
    span_id: id,
    trace_id: "t1",
    parent_span_id: null,
    name: `span-${id}`,
    span_start_time: "2026-07-01T00:00:00",
    span_end_time: "2026-07-01T00:00:01",
    duration_ms: 1000,
    ...extra,
  } as Span;
}

function traceDetail(spans: Span[]): TraceDetail {
  return {
    trace_id: "t1",
    project_id: "p1",
    spans,
  } as TraceDetail;
}

let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  FakeEventSource.instances = [];
  client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useTraceStream", () => {
  it("merges incoming spans into the key the panel reads for that source", () => {
    const key = traceQueryKey("p1", "t1", "detector");
    client.setQueryData<TraceDetail>(key, traceDetail([span("a")]));

    const { result } = renderHook(() => useTraceStream("p1", "t1", true, "detector"), { wrapper });

    emit(FakeEventSource.instances[0], "spans", {
      spans: [span("b")],
    });

    expect(client.getQueryData<TraceDetail>(key)?.spans.map((item) => item.span_id)).toEqual([
      "a",
      "b",
    ]);
    expect(result.current.isStreaming).toBe(true);
  });

  it("writes nothing to the unscoped key when a source was given", () => {
    client.setQueryData<TraceDetail>(traceQueryKey("p1", "t1", "detector"), traceDetail([]));
    client.setQueryData<TraceDetail>(traceQueryKey("p1", "t1"), traceDetail([]));

    renderHook(() => useTraceStream("p1", "t1", true, "detector"), { wrapper });
    emit(FakeEventSource.instances[0], "spans", {
      spans: [span("b")],
    });

    expect(client.getQueryData<TraceDetail>(traceQueryKey("p1", "t1"))?.spans).toEqual([]);
  });

  it("re-subscribes when source changes on a fixed trace id", () => {
    type Props = { source: "detector" | "user" };

    const { rerender } = renderHook(
      ({ source }: Props) => useTraceStream("p1", "t1", true, source),
      {
        wrapper,
        initialProps: {
          source: "detector",
        } as Props,
      },
    );

    expect(FakeEventSource.instances).toHaveLength(1);

    rerender({ source: "user" });

    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[0].closed).toBe(true);

    const userKey = traceQueryKey("p1", "t1", "user");
    client.setQueryData<TraceDetail>(userKey, traceDetail([span("a")]));

    emit(FakeEventSource.instances[1], "spans", {
      spans: [span("b")],
    });

    expect(client.getQueryData<TraceDetail>(userKey)?.spans.map((item) => item.span_id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("invalidates by the same key and closes on trace_complete", () => {
    const invalidate = vi.spyOn(client, "invalidateQueries");

    const { result } = renderHook(() => useTraceStream("p1", "t1", true, "detector"), { wrapper });

    emit(FakeEventSource.instances[0], "trace_complete", {});

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: traceQueryKey("p1", "t1", "detector"),
    });
    expect(FakeEventSource.instances[0].closed).toBe(true);
    expect(result.current.isStreaming).toBe(false);
  });

  it("clears streaming state when EventSource reports an error", () => {
    const { result } = renderHook(() => useTraceStream("p1", "t1", true, "detector"), { wrapper });
    const eventSource = FakeEventSource.instances[0];

    emit(eventSource, "spans", {
      spans: [span("live")],
    });
    expect(result.current.isStreaming).toBe(true);

    act(() => {
      // This invokes the hook's real current onerror behavior.
      eventSource.onerror?.();
    });

    expect(result.current.isStreaming).toBe(false);
    // Current behavior leaves the EventSource open for browser retry.
    expect(eventSource.closed).toBe(false);
  });

  it("closes the EventSource when the hook unmounts", () => {
    const { unmount } = renderHook(() => useTraceStream("p1", "t1", true, "detector"), { wrapper });
    const eventSource = FakeEventSource.instances[0];

    expect(eventSource.closed).toBe(false);

    act(() => {
      unmount();
    });

    expect(eventSource.closed).toBe(true);
  });

  it("does not subscribe when disabled", () => {
    renderHook(() => useTraceStream("p1", "t1", false, "detector"), { wrapper });

    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("ignores malformed events and empty span batches", () => {
    const key = traceQueryKey("p1", "t1", "detector");
    client.setQueryData<TraceDetail>(key, traceDetail([span("a")]));

    const { result } = renderHook(() => useTraceStream("p1", "t1", true, "detector"), { wrapper });
    const eventSource = FakeEventSource.instances[0];

    act(() => {
      eventSource.listeners.get("spans")?.({
        data: "not json",
      } as MessageEvent);
    });
    emit(eventSource, "spans", { spans: [] });

    expect(client.getQueryData<TraceDetail>(key)?.spans.map((item) => item.span_id)).toEqual(["a"]);
    expect(result.current.isStreaming).toBe(false);
  });
});

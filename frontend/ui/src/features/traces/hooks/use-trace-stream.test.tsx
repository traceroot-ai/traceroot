// @vitest-environment jsdom
/**
 * The stream writes into the trace-detail cache with an exact-hash setQueryData, so the
 * only thing worth asserting is that spans land at the key the panel actually reads —
 * a key that is right in shape but wrong in `source` drops every span event silently.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";

import type { Span, TraceDetail } from "@/types/api";
import { traceQueryKey } from "./index";
import { useTraceStream } from "./use-trace-stream";

/**
 * Deliver an SSE event the way the browser would: the handler calls setIsStreaming, so
 * without act() the hook's returned state lags the cache write we just made.
 */
function emit(es: FakeEventSource, type: string, data: unknown) {
  act(() => es.emit(type, data));
}

/** Minimal EventSource stand-in: jsdom has none, and we need to fire events by hand. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, (e: MessageEvent) => void>();
  closed = false;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, fn);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: unknown) {
    this.listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent);
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
  return { trace_id: "t1", project_id: "p1", spans } as TraceDetail;
}

let client: QueryClient;

function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  FakeEventSource.instances = [];
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useTraceStream", () => {
  it("merges incoming spans into the key the panel reads for that source", () => {
    const key = traceQueryKey("p1", "t1", "detector");
    client.setQueryData<TraceDetail>(key, traceDetail([span("a")]));

    const { result } = renderHook(() => useTraceStream("p1", "t1", true, "detector"), { wrapper });
    emit(FakeEventSource.instances[0], "spans", { spans: [span("b")] });

    expect(client.getQueryData<TraceDetail>(key)?.spans.map((s) => s.span_id)).toEqual(["a", "b"]);
    expect(result.current.isStreaming).toBe(true);
  });

  it("writes nothing to the unscoped key when a source was given", () => {
    client.setQueryData<TraceDetail>(traceQueryKey("p1", "t1", "detector"), traceDetail([]));
    client.setQueryData<TraceDetail>(traceQueryKey("p1", "t1"), traceDetail([]));

    renderHook(() => useTraceStream("p1", "t1", true, "detector"), { wrapper });
    emit(FakeEventSource.instances[0], "spans", { spans: [span("b")] });

    expect(client.getQueryData<TraceDetail>(traceQueryKey("p1", "t1"))?.spans).toEqual([]);
  });

  it("re-subscribes when source changes on a fixed trace id, so writes follow the key", () => {
    // Reachable because a customer-supplied trace_id can equal a run's dashless run_id:
    // traceId stays put while source flips, and a stale subscription would keep writing
    // the old key. `source` must therefore be in the effect's dependency array.
    type Props = { source: "detector" | "user" };
    const { rerender } = renderHook(
      ({ source }: Props) => useTraceStream("p1", "t1", true, source),
      { wrapper, initialProps: { source: "detector" } as Props },
    );
    expect(FakeEventSource.instances).toHaveLength(1);

    rerender({ source: "user" });
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[0].closed).toBe(true);

    const userKey = traceQueryKey("p1", "t1", "user");
    client.setQueryData<TraceDetail>(userKey, traceDetail([span("a")]));
    emit(FakeEventSource.instances[1], "spans", { spans: [span("b")] });
    expect(client.getQueryData<TraceDetail>(userKey)?.spans.map((s) => s.span_id)).toEqual([
      "a",
      "b",
    ]);
  });

  it("invalidates by the same key and closes the stream on trace_complete", () => {
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useTraceStream("p1", "t1", true, "detector"), { wrapper });

    emit(FakeEventSource.instances[0], "trace_complete", {});

    expect(invalidate).toHaveBeenCalledWith({ queryKey: traceQueryKey("p1", "t1", "detector") });
    expect(FakeEventSource.instances[0].closed).toBe(true);
    expect(result.current.isStreaming).toBe(false);
  });

  it("does not subscribe when disabled", () => {
    renderHook(() => useTraceStream("p1", "t1", false, "detector"), { wrapper });
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("ignores a malformed event and an empty span batch", () => {
    const key = traceQueryKey("p1", "t1", "detector");
    client.setQueryData<TraceDetail>(key, traceDetail([span("a")]));
    const { result } = renderHook(() => useTraceStream("p1", "t1", true, "detector"), { wrapper });

    act(() =>
      FakeEventSource.instances[0].listeners.get("spans")?.({ data: "not json" } as MessageEvent),
    );
    emit(FakeEventSource.instances[0], "spans", { spans: [] });

    expect(client.getQueryData<TraceDetail>(key)?.spans.map((s) => s.span_id)).toEqual(["a"]);
    expect(result.current.isStreaming).toBe(false);
  });
});

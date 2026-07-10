// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useTraceStream } from "./use-trace-stream";

type Listener = (event: MessageEvent) => void;

// Minimal EventSource double: same surface the hook touches, plus test
// drivers (open/emit/error*) to walk the connection through its lifecycle.
class MockEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: MockEventSource[] = [];

  readyState = MockEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Listener[]>();

  constructor(public url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: Listener) {
    const arr = this.listeners.get(type) ?? [];
    arr.push(listener);
    this.listeners.set(type, arr);
  }

  close() {
    this.readyState = MockEventSource.CLOSED;
  }

  // --- test drivers ---
  open() {
    this.readyState = MockEventSource.OPEN;
    this.onopen?.();
  }

  emit(type: string, data = "{}") {
    for (const l of this.listeners.get(type) ?? []) l({ data } as MessageEvent);
  }

  /** Browser will auto-retry: readyState stays CONNECTING. */
  errorTransient() {
    this.readyState = MockEventSource.CONNECTING;
    this.onerror?.();
  }

  /** Browser gave up: readyState CLOSED, no auto-retry. */
  errorFatal() {
    this.readyState = MockEventSource.CLOSED;
    this.onerror?.();
  }
}

let queryClient: QueryClient;
let invalidateSpy: MockInstance<QueryClient["invalidateQueries"]>;

function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const latest = () => MockEventSource.instances[MockEventSource.instances.length - 1];

const renderStream = () => renderHook(() => useTraceStream("p1", "t1", true), { wrapper });

beforeEach(() => {
  vi.useFakeTimers();
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  invalidateSpy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useTraceStream lifecycle", () => {
  it("reports connecting, then live once the connection opens", () => {
    const { result } = renderStream();
    expect(result.current.streamStatus).toBe("connecting");
    expect(result.current.isStreaming).toBe(false);
    act(() => latest().open());
    expect(result.current.streamStatus).toBe("live");
    expect(result.current.isStreaming).toBe(true);
  });

  it("merges incoming spans into the trace query cache", () => {
    queryClient.setQueryData(["trace", "p1", "t1"], { spans: [] });
    renderStream();
    act(() => latest().open());
    act(() => latest().emit("spans", JSON.stringify({ spans: [{ span_id: "a" }] })));
    const cached = queryClient.getQueryData(["trace", "p1", "t1"]) as {
      spans: { span_id: string }[];
    };
    expect(cached.spans.map((s) => s.span_id)).toEqual(["a"]);
  });

  it("trace_complete ends the stream, closes it, and refetches the final state", () => {
    const { result } = renderStream();
    act(() => latest().open());
    act(() => latest().emit("trace_complete"));
    expect(result.current.streamStatus).toBe("ended");
    expect(result.current.isStreaming).toBe(false);
    expect(latest().readyState).toBe(MockEventSource.CLOSED);
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(60_000));
    expect(MockEventSource.instances).toHaveLength(1); // never resubscribes
  });
});

describe("stream_timeout", () => {
  it("refetches the gap and resubscribes with a fresh connection", () => {
    const { result } = renderStream();
    act(() => latest().open());
    act(() => latest().emit("stream_timeout"));
    expect(MockEventSource.instances[0].readyState).toBe(MockEventSource.CLOSED);
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(result.current.streamStatus).toBe("connecting");
    act(() => vi.advanceTimersByTime(0));
    expect(MockEventSource.instances).toHaveLength(2);
    act(() => latest().open());
    expect(result.current.streamStatus).toBe("live");
  });

  it("closes out via trace_complete on the fresh connection when the trace finished", () => {
    const { result } = renderStream();
    act(() => latest().open());
    act(() => latest().emit("stream_timeout"));
    act(() => vi.advanceTimersByTime(0));
    // The server emits trace_complete immediately on subscribe for a finished trace.
    act(() => latest().emit("trace_complete"));
    expect(result.current.streamStatus).toBe("ended");
    expect(invalidateSpy).toHaveBeenCalledTimes(2); // gap refetch + completion refetch
    act(() => vi.advanceTimersByTime(60_000));
    expect(MockEventSource.instances).toHaveLength(2);
  });
});

describe("connection errors", () => {
  it("transient errors trigger exactly one gap refetch when the connection reopens", () => {
    const { result } = renderStream();
    act(() => latest().open());
    act(() => {
      latest().errorTransient();
      latest().errorTransient();
    });
    expect(result.current.streamStatus).toBe("connecting");
    expect(invalidateSpy).not.toHaveBeenCalled();
    act(() => latest().open());
    expect(result.current.streamStatus).toBe("live");
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(MockEventSource.instances).toHaveLength(1); // browser retried, we did not
  });

  it("fatal errors resubscribe with exponential backoff and eventually give up", () => {
    const { result } = renderStream();
    act(() => latest().open());

    act(() => latest().errorFatal());
    expect(result.current.streamStatus).toBe("connecting");
    act(() => vi.advanceTimersByTime(999));
    expect(MockEventSource.instances).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(MockEventSource.instances).toHaveLength(2); // retried after 1s

    act(() => latest().errorFatal());
    act(() => vi.advanceTimersByTime(2_000));
    expect(MockEventSource.instances).toHaveLength(3); // 2s

    act(() => latest().errorFatal());
    act(() => vi.advanceTimersByTime(4_000));
    act(() => latest().errorFatal());
    act(() => vi.advanceTimersByTime(8_000));
    act(() => latest().errorFatal());
    act(() => vi.advanceTimersByTime(16_000));
    expect(MockEventSource.instances).toHaveLength(6); // 4s, 8s, 16s

    act(() => latest().errorFatal());
    expect(result.current.streamStatus).toBe("disconnected");
    expect(result.current.isStreaming).toBe(false);
    act(() => vi.advanceTimersByTime(300_000));
    expect(MockEventSource.instances).toHaveLength(6); // retry budget exhausted
  });

  it("refetches are deduplicated while one is in flight", () => {
    invalidateSpy.mockReturnValue(new Promise(() => {})); // refetch never settles
    renderStream();
    act(() => latest().open());
    act(() => latest().errorTransient());
    act(() => latest().open()); // gap refetch — stays in flight
    act(() => latest().emit("stream_timeout")); // would refetch again
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });
});

describe("unmount", () => {
  it("closes the stream and cancels any pending retry", () => {
    const { unmount } = renderStream();
    act(() => latest().open());
    act(() => latest().errorFatal());
    unmount();
    expect(MockEventSource.instances[0].readyState).toBe(MockEventSource.CLOSED);
    act(() => vi.advanceTimersByTime(300_000));
    expect(MockEventSource.instances).toHaveLength(1); // retry timer cancelled
  });
});

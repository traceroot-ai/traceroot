// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import type { DraftSpec, TimeRange, WidgetSpec } from "../types";
import {
  quantizeRange,
  useWidgetData,
  useWidgetFieldValues,
  useWidgetPreview,
  useWidgetSchema,
} from "./use-widget-data";

vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({
    data: { user: { id: "u1", email: "u@example.com" } },
    isPending: false,
  }),
}));
vi.mock("../api");

const RANGE: TimeRange = {
  start: new Date("2026-06-01T00:00:00Z"),
  end: new Date("2026-06-02T00:00:00Z"),
};

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useWidgetFieldValues", () => {
  beforeEach(() => {
    vi.mocked(api.fetchWidgetFieldValues).mockReset();
  });

  it("fetches stored values once enabled", async () => {
    vi.mocked(api.fetchWidgetFieldValues).mockResolvedValue({
      field: "model_name",
      values: [{ value: "gpt-4o", count: 3 }],
    });
    const { result } = renderHook(
      () => useWidgetFieldValues("p1", "spans", "model_name", RANGE, true),
      { wrapper },
    );
    await waitFor(() => expect(result.current.values).toHaveLength(1));
    expect(result.current.values[0]).toEqual({ value: "gpt-4o", count: 3 });
    expect(api.fetchWidgetFieldValues).toHaveBeenCalledWith("p1", "spans", "model_name", RANGE, {
      id: "u1",
      email: "u@example.com",
    });
  });

  it("stays idle while disabled — no fetch, no values", async () => {
    const { result } = renderHook(
      () => useWidgetFieldValues("p1", "spans", "model_name", RANGE, false),
      { wrapper },
    );
    expect(result.current).toEqual({ values: [], isLoading: false });
    expect(api.fetchWidgetFieldValues).not.toHaveBeenCalled();
  });

  it("stays idle until a field is picked", () => {
    const { result } = renderHook(() => useWidgetFieldValues("p1", "spans", "", RANGE, true), {
      wrapper,
    });
    expect(result.current).toEqual({ values: [], isLoading: false });
    expect(api.fetchWidgetFieldValues).not.toHaveBeenCalled();
  });
});

describe("useWidgetSchema", () => {
  beforeEach(() => {
    vi.mocked(api.fetchWidgetSchema).mockReset();
  });

  it("fetches the schema once the session is ready", async () => {
    const schema = { spans: { fields: {} }, traces: { fields: {} } };
    vi.mocked(api.fetchWidgetSchema).mockResolvedValue(schema);
    const { result } = renderHook(() => useWidgetSchema("p1"), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(schema));
    expect(api.fetchWidgetSchema).toHaveBeenCalledWith("p1", { id: "u1", email: "u@example.com" });
  });

  it("stays disabled without a projectId", () => {
    renderHook(() => useWidgetSchema(""), { wrapper });
    expect(api.fetchWidgetSchema).not.toHaveBeenCalled();
  });
});

describe("useWidgetData", () => {
  const SPEC: WidgetSpec = {
    view: "spans",
    filters: [],
    metric: { measure: "count", agg: "count" },
    breakdown: null,
    display: { type: "number" },
  };

  beforeEach(() => {
    vi.mocked(api.runWidgetQuery).mockReset();
  });

  it("fetches when enabled with a complete spec, passing the user through", async () => {
    const queryResult = { columns: ["count"], rows: [[1]], meta: {} };
    vi.mocked(api.runWidgetQuery).mockResolvedValue(queryResult);
    const { result } = renderHook(() => useWidgetData("p1", "w1", SPEC, RANGE), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(queryResult));
    expect(api.runWidgetQuery).toHaveBeenCalledWith("p1", SPEC, RANGE, {
      id: "u1",
      email: "u@example.com",
    });
  });

  it("stays disabled when enabled=false", () => {
    renderHook(() => useWidgetData("p1", "w1", SPEC, RANGE, false), { wrapper });
    expect(api.runWidgetQuery).not.toHaveBeenCalled();
  });

  it("stays disabled without a widgetId", () => {
    renderHook(() => useWidgetData("p1", "", SPEC, RANGE), { wrapper });
    expect(api.runWidgetQuery).not.toHaveBeenCalled();
  });

  it("floors the window to the minute for the request", async () => {
    vi.mocked(api.runWidgetQuery).mockResolvedValue({ columns: [], rows: [], meta: {} });
    const ragged: TimeRange = {
      start: new Date("2026-06-01T00:00:10.500Z"),
      end: new Date("2026-06-02T00:00:42.900Z"),
    };
    renderHook(() => useWidgetData("p1", "w1", SPEC, ragged), { wrapper });

    await waitFor(() => expect(api.runWidgetQuery).toHaveBeenCalled());
    const [, , window] = vi.mocked(api.runWidgetQuery).mock.calls[0];
    expect(window.start.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(window.end.toISOString()).toBe("2026-06-02T00:00:00.000Z");
  });

  it("serves a same-minute remount from cache without refetching", async () => {
    // Relative presets recompute end="now" per mount: raw millisecond keys
    // would refire every widget on every dashboard round-trip. Same client
    // across two mounts = the navigation case.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const sharedWrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    vi.mocked(api.runWidgetQuery).mockResolvedValue({ columns: [], rows: [], meta: {} });

    const first = renderHook(
      () =>
        useWidgetData("p1", "w1", SPEC, {
          start: new Date("2026-06-01T00:00:05Z"),
          end: new Date("2026-06-02T00:00:05Z"),
        }),
      { wrapper: sharedWrapper },
    );
    await waitFor(() => expect(api.runWidgetQuery).toHaveBeenCalledTimes(1));
    first.unmount();

    // Seconds later the remounted page computes a slightly different raw
    // window — same floored minute, so the cache answers with zero requests.
    const second = renderHook(
      () =>
        useWidgetData("p1", "w1", SPEC, {
          start: new Date("2026-06-01T00:00:25Z"),
          end: new Date("2026-06-02T00:00:25Z"),
        }),
      { wrapper: sharedWrapper },
    );
    await waitFor(() => expect(second.result.current.data).toBeTruthy());
    expect(api.runWidgetQuery).toHaveBeenCalledTimes(1);
    client.clear();
  });
});

describe("quantizeRange", () => {
  it("widens a sub-minute window to one minute instead of an empty range", () => {
    const q = quantizeRange({
      start: new Date("2026-06-01T00:00:10Z"),
      end: new Date("2026-06-01T00:00:40Z"),
    });
    expect(q.start.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    // Both bounds floor to the same minute; the end must stay one step ahead
    // or the backend would reject end <= start.
    expect(q.end.toISOString()).toBe("2026-06-01T00:01:00.000Z");
  });
});

describe("useWidgetPreview", () => {
  beforeEach(() => {
    vi.mocked(api.runWidgetQuery).mockReset();
  });

  it("never queries for an incomplete draft", () => {
    const draft: DraftSpec = { view: "spans", metric: { measure: "count" } };
    renderHook(() => useWidgetPreview("p1", draft, RANGE), { wrapper });
    expect(api.runWidgetQuery).not.toHaveBeenCalled();
  });

  it("queries with the parsed spec once the draft is complete", async () => {
    const draft: DraftSpec = {
      view: "spans",
      metric: { measure: "count", agg: "count" },
      display: { type: "number" },
    };
    const queryResult = { columns: ["count"], rows: [[1]], meta: {} };
    vi.mocked(api.runWidgetQuery).mockResolvedValue(queryResult);
    const parsed = {
      view: "spans",
      filters: [],
      metric: { measure: "count", agg: "count" },
      breakdown: null,
      display: { type: "number" },
    };
    const { result } = renderHook(() => useWidgetPreview("p1", draft, RANGE), { wrapper });
    // The result carries the spec that produced it so the preview can render
    // kept-previous data with matching display/unit/agg semantics.
    await waitFor(() => expect(result.current.data).toEqual({ spec: parsed, result: queryResult }));
    expect(api.runWidgetQuery).toHaveBeenCalledWith("p1", parsed, RANGE, {
      id: "u1",
      email: "u@example.com",
    });
  });
});

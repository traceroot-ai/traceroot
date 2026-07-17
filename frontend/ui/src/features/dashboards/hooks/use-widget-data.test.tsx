// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import type { DraftSpec, TimeRange, WidgetSpec } from "../types";
import {
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
    const { result } = renderHook(() => useWidgetPreview("p1", draft, RANGE), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(queryResult));
    expect(api.runWidgetQuery).toHaveBeenCalledWith(
      "p1",
      {
        view: "spans",
        filters: [],
        metric: { measure: "count", agg: "count" },
        breakdown: null,
        display: { type: "number" },
      },
      RANGE,
      { id: "u1", email: "u@example.com" },
    );
  });
});

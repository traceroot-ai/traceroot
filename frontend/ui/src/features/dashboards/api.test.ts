import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchNextApi, fetchTraceApi } from "@/lib/api/client";
import {
  createDashboard,
  createWidget,
  deleteDashboard,
  deleteWidget,
  fetchWidgetFieldValues,
  fetchWidgetSchema,
  getDashboard,
  listDashboards,
  runWidgetQuery,
  updateDashboard,
  updateWidget,
} from "./api";
import type { WidgetSpec } from "./types";

vi.mock("@/lib/api/client", () => ({
  fetchNextApi: vi.fn(),
  fetchTraceApi: vi.fn().mockResolvedValue({ field: "model_name", values: [] }),
}));

beforeEach(() => {
  vi.mocked(fetchNextApi).mockReset();
  vi.mocked(fetchTraceApi).mockReset().mockResolvedValue({ field: "model_name", values: [] });
});

describe("fetchWidgetFieldValues", () => {
  it("hits the widgets field-values route with the window bounds", async () => {
    const range = {
      start: new Date("2026-06-01T00:00:00Z"),
      end: new Date("2026-06-02T00:00:00Z"),
    };
    await fetchWidgetFieldValues("p1", "spans", "model_name", range, {
      id: "u1",
      email: "u@example.com",
    });
    const [path, , user] = vi.mocked(fetchTraceApi).mock.calls[0];
    expect(path).toBe(
      "/projects/p1/widgets/field-values/spans/model_name" +
        "?start_time=2026-06-01T00%3A00%3A00.000Z&end_time=2026-06-02T00%3A00%3A00.000Z",
    );
    expect(user).toEqual({ id: "u1", email: "u@example.com" });
  });
});

describe("dashboard CRUD", () => {
  it("listDashboards gets the project's dashboards", () => {
    listDashboards("p1");
    expect(fetchNextApi).toHaveBeenCalledWith("/projects/p1/dashboards");
  });

  it("getDashboard gets a single dashboard by id", () => {
    getDashboard("p1", "d1");
    expect(fetchNextApi).toHaveBeenCalledWith("/projects/p1/dashboards/d1");
  });

  it("createDashboard posts the name and description", () => {
    createDashboard("p1", { name: "Overview", description: "Key metrics" });
    expect(fetchNextApi).toHaveBeenCalledWith("/projects/p1/dashboards", {
      method: "POST",
      body: JSON.stringify({ name: "Overview", description: "Key metrics" }),
    });
  });

  it("updateDashboard patches the changed fields", () => {
    updateDashboard("p1", "d1", { name: "Renamed", layout: [{ i: "w1", x: 0, y: 0, w: 2, h: 2 }] });
    expect(fetchNextApi).toHaveBeenCalledWith("/projects/p1/dashboards/d1", {
      method: "PATCH",
      body: JSON.stringify({ name: "Renamed", layout: [{ i: "w1", x: 0, y: 0, w: 2, h: 2 }] }),
    });
  });

  it("deleteDashboard issues a DELETE to the dashboard route", () => {
    deleteDashboard("p1", "d1");
    expect(fetchNextApi).toHaveBeenCalledWith("/projects/p1/dashboards/d1", {
      method: "DELETE",
    });
  });
});

describe("widget CRUD", () => {
  it("createWidget posts the widget definition under the dashboard", () => {
    createWidget("p1", "d1", { title: "Latency", type: "query", spec: { view: "spans" } });
    expect(fetchNextApi).toHaveBeenCalledWith("/projects/p1/dashboards/d1/widgets", {
      method: "POST",
      body: JSON.stringify({ title: "Latency", type: "query", spec: { view: "spans" } }),
    });
  });

  it("updateWidget patches an existing widget", () => {
    updateWidget("p1", "d1", "w1", { title: "Renamed" });
    expect(fetchNextApi).toHaveBeenCalledWith("/projects/p1/dashboards/d1/widgets/w1", {
      method: "PATCH",
      body: JSON.stringify({ title: "Renamed" }),
    });
  });

  it("deleteWidget issues a DELETE to the widget route", () => {
    deleteWidget("p1", "d1", "w1");
    expect(fetchNextApi).toHaveBeenCalledWith("/projects/p1/dashboards/d1/widgets/w1", {
      method: "DELETE",
    });
  });
});

describe("fetchWidgetSchema", () => {
  it("gets the schema for a project's widgets and passes the user through", async () => {
    await fetchWidgetSchema("p1", { id: "u1", email: "u@example.com" });
    expect(fetchTraceApi).toHaveBeenCalledWith(
      "/projects/p1/widgets/schema",
      {},
      { id: "u1", email: "u@example.com" },
    );
  });
});

describe("runWidgetQuery", () => {
  it("posts the spec and ISO window bounds, passing the user through", async () => {
    const spec: WidgetSpec = {
      view: "spans",
      filters: [],
      metric: { measure: "count", agg: "count" },
      breakdown: null,
      display: { type: "number" },
    };
    const range = {
      start: new Date("2026-06-01T00:00:00Z"),
      end: new Date("2026-06-02T00:00:00Z"),
    };
    await runWidgetQuery("p1", spec, range, { id: "u1", email: "u@example.com" });
    expect(fetchTraceApi).toHaveBeenCalledWith(
      "/projects/p1/widgets/query",
      {
        method: "POST",
        body: JSON.stringify({
          spec,
          start_time: "2026-06-01T00:00:00.000Z",
          end_time: "2026-06-02T00:00:00.000Z",
        }),
      },
      { id: "u1", email: "u@example.com" },
    );
  });
});

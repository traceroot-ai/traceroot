// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import * as api from "../api";
import { useDashboard, useDashboardMutations, useDashboards } from "./use-dashboards";
import type { DashboardDetail, DashboardSummary, Widget } from "../types";

vi.mock("../api");
const broadcastMock = vi.fn();
vi.mock("@/lib/cross-tab-sync", () => ({
  broadcastQueryInvalidation: (...args: unknown[]) => broadcastMock(...args),
}));

afterEach(() => {
  cleanup();
});

function makeWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { wrapper, invalidateSpy, queryClient };
}

const fakeSummary: DashboardSummary = {
  id: "dash-1",
  name: "Overview",
  description: null,
  isDefault: true,
  updateTime: "2026-06-01T00:00:00Z",
};

const fakeDetail: DashboardDetail = {
  ...fakeSummary,
  layout: [],
  widgets: [],
};

const fakeWidget: Widget = {
  id: "widget-1",
  dashboardId: "dash-1",
  title: "My Widget",
  type: "query",
  spec: {},
  displayConfig: {},
};

beforeEach(() => {
  vi.mocked(api.listDashboards).mockReset();
  vi.mocked(api.getDashboard).mockReset();
  vi.mocked(api.createDashboard).mockReset();
  vi.mocked(api.updateDashboard).mockReset();
  vi.mocked(api.deleteDashboard).mockReset();
  vi.mocked(api.createWidget).mockReset();
  vi.mocked(api.updateWidget).mockReset();
  vi.mocked(api.deleteWidget).mockReset();
  broadcastMock.mockReset();
});

// ---------------------------------------------------------------------------
// useDashboards / useDashboard
// ---------------------------------------------------------------------------
describe("useDashboards", () => {
  it("unwraps the data array from the list response", async () => {
    vi.mocked(api.listDashboards).mockResolvedValue({ data: [fakeSummary] });
    const { wrapper } = makeWrapper();

    const { result } = renderHook(() => useDashboards("proj-1"), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([fakeSummary]));
    expect(api.listDashboards).toHaveBeenCalledWith("proj-1");
  });

  it("stays disabled when projectId is empty", () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useDashboards(""), { wrapper });
    expect(result.current.fetchStatus).toBe("idle");
    expect(api.listDashboards).not.toHaveBeenCalled();
  });
});

describe("useDashboard", () => {
  it("unwraps the dashboard from the detail response", async () => {
    vi.mocked(api.getDashboard).mockResolvedValue({ dashboard: fakeDetail });
    const { wrapper } = makeWrapper();

    const { result } = renderHook(() => useDashboard("proj-1", "dash-1"), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(fakeDetail));
    expect(api.getDashboard).toHaveBeenCalledWith("proj-1", "dash-1");
  });

  it("stays disabled when dashboardId is empty", () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useDashboard("proj-1", ""), { wrapper });
    expect(result.current.fetchStatus).toBe("idle");
    expect(api.getDashboard).not.toHaveBeenCalled();
  });

  it("stays disabled when projectId is empty", () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useDashboard("", "dash-1"), { wrapper });
    expect(result.current.fetchStatus).toBe("idle");
    expect(api.getDashboard).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// useDashboardMutations
// ---------------------------------------------------------------------------
describe("useDashboardMutations", () => {
  it("createDashboard: calls api.createDashboard and invalidates the list only (no dashboardId scope)", async () => {
    vi.mocked(api.createDashboard).mockResolvedValue({ dashboard: fakeSummary });
    const { wrapper, invalidateSpy } = makeWrapper();

    const { result } = renderHook(() => useDashboardMutations("proj-1"), { wrapper });
    result.current.createDashboard.mutate({ name: "New Dash" });
    await waitFor(() => expect(result.current.createDashboard.isSuccess).toBe(true));

    expect(api.createDashboard).toHaveBeenCalledWith("proj-1", { name: "New Dash" });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["dashboards", "proj-1"] });
    expect(broadcastMock).toHaveBeenCalledWith(["dashboards", "proj-1"]);
    // No dashboardId was passed to the hook, so no detail-scoped invalidation.
    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: expect.arrayContaining(["dashboard"]),
    });
  });

  it("updateLayout: calls api.updateDashboard with the layout and invalidates list + detail", async () => {
    vi.mocked(api.updateDashboard).mockResolvedValue({ dashboard: fakeSummary });
    const { wrapper, invalidateSpy } = makeWrapper();
    const layout = [{ i: "w1", x: 0, y: 0, w: 4, h: 4 }];

    const { result } = renderHook(() => useDashboardMutations("proj-1", "dash-1"), { wrapper });
    result.current.updateLayout.mutate(layout);
    await waitFor(() => expect(result.current.updateLayout.isSuccess).toBe(true));

    expect(api.updateDashboard).toHaveBeenCalledWith("proj-1", "dash-1", { layout });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["dashboards", "proj-1"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["dashboard", "proj-1", "dash-1"] });
    expect(broadcastMock).toHaveBeenCalledWith(["dashboards", "proj-1"]);
    expect(broadcastMock).toHaveBeenCalledWith(["dashboard", "proj-1", "dash-1"]);
  });

  it("updateLayout: writes the layout into the detail cache optimistically", async () => {
    // Never-resolving PATCH: the cache must already hold the new layout while
    // the request is in flight, so a poll response can't revert the grid.
    vi.mocked(api.updateDashboard).mockReturnValue(new Promise(() => {}));
    const { wrapper, queryClient } = makeWrapper();
    const key = ["dashboard", "proj-1", "dash-1"];
    queryClient.setQueryData(key, { dashboard: { ...fakeSummary, layout: [], widgets: [] } });

    const layout = [{ i: "w1", x: 2, y: 0, w: 4, h: 4 }];
    const { result } = renderHook(() => useDashboardMutations("proj-1", "dash-1"), { wrapper });
    result.current.updateLayout.mutate(layout);

    await waitFor(() => {
      const cached = queryClient.getQueryData(key) as { dashboard: { layout: unknown } };
      expect(cached.dashboard.layout).toEqual(layout);
    });
  });

  it("updateLayout: refetches the truth when the PATCH fails", async () => {
    vi.mocked(api.updateDashboard).mockRejectedValue(new Error("boom"));
    const { wrapper, invalidateSpy } = makeWrapper();

    const { result } = renderHook(() => useDashboardMutations("proj-1", "dash-1"), { wrapper });
    result.current.updateLayout.mutate([{ i: "w1", x: 0, y: 0, w: 4, h: 4 }]);
    await waitFor(() => expect(result.current.updateLayout.isError).toBe(true));

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["dashboard", "proj-1", "dash-1"] });
  });

  it("renameDashboard: calls api.updateDashboard with name/description and invalidates list + detail", async () => {
    vi.mocked(api.updateDashboard).mockResolvedValue({ dashboard: fakeSummary });
    const { wrapper, invalidateSpy } = makeWrapper();

    const { result } = renderHook(() => useDashboardMutations("proj-1", "dash-1"), { wrapper });
    result.current.renameDashboard.mutate({ name: "Renamed", description: null });
    await waitFor(() => expect(result.current.renameDashboard.isSuccess).toBe(true));

    expect(api.updateDashboard).toHaveBeenCalledWith("proj-1", "dash-1", {
      name: "Renamed",
      description: null,
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["dashboards", "proj-1"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["dashboard", "proj-1", "dash-1"] });
  });

  it("removeDashboard: calls api.deleteDashboard with the given id and invalidates list + that dashboard's detail", async () => {
    vi.mocked(api.deleteDashboard).mockResolvedValue({ deleted: true });
    const { wrapper, invalidateSpy } = makeWrapper();

    // Hook-level dashboardId differs from the id passed to mutate — the
    // mutation should scope invalidation to the id it was called with.
    const { result } = renderHook(() => useDashboardMutations("proj-1", "dash-1"), { wrapper });
    result.current.removeDashboard.mutate("dash-2");
    await waitFor(() => expect(result.current.removeDashboard.isSuccess).toBe(true));

    expect(api.deleteDashboard).toHaveBeenCalledWith("proj-1", "dash-2");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["dashboards", "proj-1"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["dashboard", "proj-1", "dash-2"] });
  });

  it("createWidget: calls api.createWidget scoped to the dashboard and invalidates list + detail", async () => {
    vi.mocked(api.createWidget).mockResolvedValue({ widget: fakeWidget });
    const { wrapper, invalidateSpy } = makeWrapper();
    const input = { title: "New Widget", type: "query" as const, spec: { view: "spans" } };

    const { result } = renderHook(() => useDashboardMutations("proj-1", "dash-1"), { wrapper });
    result.current.createWidget.mutate(input);
    await waitFor(() => expect(result.current.createWidget.isSuccess).toBe(true));

    expect(api.createWidget).toHaveBeenCalledWith("proj-1", "dash-1", input);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["dashboards", "proj-1"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["dashboard", "proj-1", "dash-1"] });
  });

  it("updateWidget: calls api.updateWidget with widgetId split out of the input and invalidates list + detail", async () => {
    vi.mocked(api.updateWidget).mockResolvedValue({ widget: fakeWidget });
    const { wrapper, invalidateSpy } = makeWrapper();

    const { result } = renderHook(() => useDashboardMutations("proj-1", "dash-1"), { wrapper });
    result.current.updateWidget.mutate({ widgetId: "widget-1", title: "Updated" });
    await waitFor(() => expect(result.current.updateWidget.isSuccess).toBe(true));

    expect(api.updateWidget).toHaveBeenCalledWith("proj-1", "dash-1", "widget-1", {
      title: "Updated",
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["dashboards", "proj-1"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["dashboard", "proj-1", "dash-1"] });
  });

  it("removeWidget: calls api.deleteWidget with the widgetId and invalidates list + detail", async () => {
    vi.mocked(api.deleteWidget).mockResolvedValue({ deleted: true });
    const { wrapper, invalidateSpy } = makeWrapper();

    const { result } = renderHook(() => useDashboardMutations("proj-1", "dash-1"), { wrapper });
    result.current.removeWidget.mutate("widget-1");
    await waitFor(() => expect(result.current.removeWidget.isSuccess).toBe(true));

    expect(api.deleteWidget).toHaveBeenCalledWith("proj-1", "dash-1", "widget-1");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["dashboards", "proj-1"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["dashboard", "proj-1", "dash-1"] });
  });
});

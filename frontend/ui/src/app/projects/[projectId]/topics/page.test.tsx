// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { TaskGroupsOverview } from "@/ee/features/task-groups/types";

vi.mock("next/navigation", () => ({ useParams: () => ({ projectId: "p1" }) }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));
vi.mock("@/components/date-filter-select", () => ({ DateFilterSelect: () => null }));
vi.mock("@/lib/hooks/use-retention", () => ({
  useRetention: () => ({ retentionDays: null, onUpgradeClick: vi.fn() }),
}));
vi.mock("@/lib/hooks/use-list-page-state", () => ({
  useListPageState: () => ({
    state: { dateFilter: "7d", customStartDate: undefined, customEndDate: undefined },
    queryOptions: { start_after: "2026-11-01T00:00:00Z", end_before: undefined },
    updateDateFilter: vi.fn(),
    updateCustomRange: vi.fn(),
  }),
}));
vi.mock("@/ee/features/task-groups/components/topics-trend-chart", () => ({
  TopicsTrendChart: () => <div data-testid="chart" />,
}));

const hooks = vi.hoisted(() => ({
  overview: vi.fn(),
  update: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@/ee/features/task-groups/hooks", () => ({
  useTaskGroups: hooks.overview,
  useUpdateTaskGroupSettings: () => ({ mutate: hooks.update, isPending: false, isError: false }),
  useRefreshTaskGroups: () => hooks.refresh(),
}));

import TopicsPage from "./page";

const base: TaskGroupsOverview = {
  state: {
    enabled: true,
    status: "active",
    dailyCostCapUsd: 1,
    spentTodayUsd: 0,
    summariesToday: 0,
    keyConfigured: true,
  },
  minDigests: 100,
  digestsInWindow: 250,
  sampled: 10,
  ungrouped: 0,
  fittedAt: "2026-11-08T00:00:00Z",
  groups: [{ groupId: "g1", name: "Refunds", description: "d", count: 10, share: 1, trend: [] }],
  days: ["2026-11-08"],
  refreshAvailableAt: null,
};

const show = (data: Partial<TaskGroupsOverview>) =>
  hooks.overview.mockReturnValue({
    data: { ...base, ...data },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  });

beforeEach(() => {
  hooks.refresh.mockReturnValue({ mutate: vi.fn(), isPending: false, isError: false });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Topics page", () => {
  it("lists the topics with the estimate note when on", () => {
    show({});
    render(<TopicsPage />);
    expect(screen.getByRole("link", { name: "Refunds" }).getAttribute("href")).toContain(
      "/projects/p1/traces?",
    );
    expect(screen.getByText(/Shares are estimates from 10 sampled traces/)).toBeTruthy();
    expect(screen.getByTestId("chart")).toBeTruthy();
  });

  it("is off by default: says so, shows no table, and turns on from the button or the switch", () => {
    show({
      state: { ...base.state, enabled: false, status: "off" },
      groups: [],
      fittedAt: null,
    });
    render(<TopicsPage />);
    expect(screen.getByText("Topics is off for this project")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    expect(hooks.update).toHaveBeenCalledWith({ enabled: true });
    fireEvent.click(screen.getByRole("switch"));
    expect(hooks.update).toHaveBeenCalledTimes(2);
  });

  it("says when there is not enough data yet", () => {
    show({
      state: { ...base.state, status: "collecting" },
      groups: [],
      fittedAt: null,
      digestsInWindow: 62,
    });
    render(<TopicsPage />);
    expect(screen.getByText("Not enough data yet")).toBeTruthy();
    expect(screen.getByText(/62 of 100 summaries so far/)).toBeTruthy();
  });

  it("disables Refresh now while off and while a recent request cools down", () => {
    show({ state: { ...base.state, enabled: false, status: "off" }, groups: [], fittedAt: null });
    const { unmount } = render(<TopicsPage />);
    expect(
      (screen.getByRole("button", { name: /Refresh now/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    unmount();
    show({ refreshAvailableAt: new Date(Date.now() + 600_000).toISOString() });
    render(<TopicsPage />);
    expect(
      (screen.getByRole("button", { name: /Refresh now/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

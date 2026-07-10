// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardSummary } from "@/features/dashboards/types";
import DashboardIndexPage from "./page";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1" }),
  useRouter: () => ({ replace }),
}));

const refetch = vi.fn();
vi.mock("@/features/dashboards/hooks/use-dashboards", () => ({
  useDashboards: vi.fn(),
}));

import { useDashboards } from "@/features/dashboards/hooks/use-dashboards";

function mockDashboards(data: DashboardSummary[] | undefined, error: unknown = null) {
  vi.mocked(useDashboards).mockReturnValue({
    data,
    error,
    refetch,
  } as unknown as ReturnType<typeof useDashboards>);
}

const DASH_A: DashboardSummary = {
  id: "d1",
  name: "Overview",
  description: null,
  isDefault: false,
  updateTime: "",
};
const DASH_B: DashboardSummary = {
  id: "d2",
  name: "Costs",
  description: null,
  isDefault: true,
  updateTime: "",
};

describe("DashboardIndexPage", () => {
  afterEach(cleanup);
  beforeEach(() => {
    replace.mockReset();
    refetch.mockReset();
  });

  it("shows a loading state while the dashboard list is in flight", () => {
    mockDashboards(undefined);
    render(<DashboardIndexPage />);
    expect(screen.getByText("Loading dashboards…")).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });

  it("redirects to the default dashboard once the list resolves", () => {
    mockDashboards([DASH_A, DASH_B]);
    render(<DashboardIndexPage />);
    expect(replace).toHaveBeenCalledWith("/projects/p1/dashboard/d2");
  });

  it("redirects to the first dashboard when none is marked default", () => {
    mockDashboards([
      { ...DASH_A, isDefault: false },
      { ...DASH_B, isDefault: false },
    ]);
    render(<DashboardIndexPage />);
    expect(replace).toHaveBeenCalledWith("/projects/p1/dashboard/d1");
  });

  it("shows a retry button on error and refetches on click", () => {
    mockDashboards(undefined, new Error("boom"));
    render(<DashboardIndexPage />);
    expect(screen.getByText("Failed to load dashboards — retry")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

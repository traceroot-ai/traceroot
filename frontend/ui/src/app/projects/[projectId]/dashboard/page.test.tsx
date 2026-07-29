// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardListItem } from "@/features/dashboards/types";
import DashboardIndexPage from "./page";

const replace = vi.fn();
const push = vi.fn();
let searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1" }),
  useRouter: () => ({ replace, push }),
  useSearchParams: () => searchParams,
}));

vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));

// The dialogs carry their own tests; here they only need to mount.
vi.mock("@/features/dashboards/components/CreateDashboardDialog", () => ({
  CreateDashboardDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="create-dialog" /> : null,
}));
vi.mock("@/features/dashboards/components/EditDashboardDialog", () => ({
  EditDashboardDialog: ({
    target,
  }: {
    target: { name: string; description: string | null } | null;
  }) =>
    target ? (
      <div data-testid="edit-dialog">
        {target.name}:{target.description ?? "∅"}
      </div>
    ) : null,
}));
vi.mock("@/features/dashboards/components/DeleteDashboardDialog", () => ({
  DeleteDashboardDialog: ({ target }: { target: { name: string } | null }) =>
    target ? <div data-testid="delete-dialog">{target.name}</div> : null,
}));

const refetch = vi.fn();
vi.mock("@/features/dashboards/hooks/use-dashboards", () => ({
  useDashboards: vi.fn(),
}));

import { useDashboards } from "@/features/dashboards/hooks/use-dashboards";

function mockDashboards(data: DashboardListItem[] | undefined, error: unknown = null) {
  vi.mocked(useDashboards).mockReturnValue({
    data,
    error,
    refetch,
  } as unknown as ReturnType<typeof useDashboards>);
}

const OVERVIEW: DashboardListItem = {
  id: "d1",
  name: "Overview",
  description: null,
  isDefault: true,
  creator: "Ada",
  createTime: "2026-06-01T10:00:00Z",
  updateTime: "2026-07-01T10:00:00Z",
};
const COSTS: DashboardListItem = {
  id: "d2",
  name: "Costs",
  description: "Cost breakdowns",
  isDefault: false,
  creator: null,
  createTime: "2026-06-02T10:00:00Z",
  updateTime: "2026-07-02T10:00:00Z",
};

describe("DashboardIndexPage", () => {
  afterEach(cleanup);
  beforeEach(() => {
    replace.mockReset();
    push.mockReset();
    refetch.mockReset();
    searchParams = new URLSearchParams();
  });

  it("shows a loading state while the dashboard list is in flight", () => {
    mockDashboards(undefined);
    render(<DashboardIndexPage />);
    expect(screen.getByText("Loading dashboards…")).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });

  it("auto-opens the only dashboard instead of listing it", () => {
    mockDashboards([OVERVIEW]);
    render(<DashboardIndexPage />);
    expect(replace).toHaveBeenCalledWith("/projects/p1/dashboard/d1");
    // No list flashes while the redirect is in flight.
    expect(screen.queryByText("Dashboards")).toBeNull();
    expect(screen.getByText("Loading dashboards…")).toBeTruthy();
  });

  it("auto-opens a sole non-default dashboard too (the rule is count-based)", () => {
    mockDashboards([{ ...COSTS, isDefault: false }]);
    render(<DashboardIndexPage />);
    expect(replace).toHaveBeenCalledWith("/projects/p1/dashboard/d2");
  });

  it("lists dashboards when there is more than one, without redirecting", () => {
    mockDashboards([OVERVIEW, COSTS]);
    render(<DashboardIndexPage />);
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByText("Dashboards")).toBeTruthy();
    expect(screen.getByText("Overview")).toBeTruthy();
    expect(screen.getByText("Costs")).toBeTruthy();
    // description column: value for Costs, em-dash for the description-less
    expect(screen.getByText("Cost breakdowns")).toBeTruthy();
    // owner and created sit between Description and Updated (Updated stays last)
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers.slice(1)).toEqual(["Description", "Owner", "Created", "Updated", ""]);
    expect(screen.getByText("Ada")).toBeTruthy();
    // em-dashes: Overview's missing description, Costs' deleted creator
    expect(screen.getAllByText("—")).toHaveLength(2);
    // no marker glyph on the default dashboard — its row reads like any other
    expect(screen.queryByText("⌂")).toBeNull();
  });

  it("keeps showing the list when a delete brings it down to one row", () => {
    mockDashboards([OVERVIEW, COSTS]);
    const { rerender } = render(<DashboardIndexPage />);
    expect(screen.getByText("Costs")).toBeTruthy();

    mockDashboards([OVERVIEW]);
    rerender(<DashboardIndexPage />);
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByText("Overview")).toBeTruthy();
  });

  it("navigates into a dashboard on row click", () => {
    mockDashboards([OVERVIEW, COSTS]);
    render(<DashboardIndexPage />);
    fireEvent.click(screen.getByText("Costs"));
    expect(push).toHaveBeenCalledWith("/projects/p1/dashboard/d2");
  });

  it("opens the create dialog from the header button", () => {
    mockDashboards([OVERVIEW, COSTS]);
    render(<DashboardIndexPage />);
    fireEvent.click(screen.getByRole("button", { name: "＋ New dashboard" }));
    expect(screen.getByTestId("create-dialog")).toBeTruthy();
  });

  it("opens the edit dialog from a row's actions with the row's fields, without navigating", () => {
    mockDashboards([OVERVIEW, COSTS]);
    render(<DashboardIndexPage />);
    fireEvent.click(screen.getAllByRole("button", { name: "Dashboard actions" })[1]);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByTestId("edit-dialog").textContent).toBe("Costs:Cost breakdowns");
    expect(push).not.toHaveBeenCalled();
  });

  it("opens the delete confirm from a row's actions without navigating", () => {
    mockDashboards([OVERVIEW, COSTS]);
    render(<DashboardIndexPage />);
    fireEvent.click(screen.getAllByRole("button", { name: "Dashboard actions" })[1]);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByTestId("delete-dialog").textContent).toBe("Costs");
    expect(push).not.toHaveBeenCalled();
  });

  it("?list=1 pins the list even for a sole dashboard, keeping create reachable", () => {
    searchParams = new URLSearchParams("list=1");
    mockDashboards([OVERVIEW]);
    render(<DashboardIndexPage />);
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByText("Overview")).toBeTruthy();
    expect(screen.getByRole("button", { name: "＋ New dashboard" })).toBeTruthy();
  });

  it("disables Delete for a sole dashboard — the API would reject it anyway", () => {
    searchParams = new URLSearchParams("list=1");
    mockDashboards([OVERVIEW]);
    render(<DashboardIndexPage />);
    fireEvent.click(screen.getByRole("button", { name: "Dashboard actions" }));
    const del = screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    fireEvent.click(del);
    expect(screen.queryByTestId("delete-dialog")).toBeNull();
  });

  it("keeps Delete enabled when other dashboards remain", () => {
    mockDashboards([OVERVIEW, COSTS]);
    render(<DashboardIndexPage />);
    fireEvent.click(screen.getAllByRole("button", { name: "Dashboard actions" })[0]);
    const del = screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement;
    expect(del.disabled).toBe(false);
  });

  it("shows a retry button on error and refetches on click", () => {
    mockDashboards(undefined, new Error("boom"));
    render(<DashboardIndexPage />);
    expect(screen.getByText("Failed to load dashboards — retry")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

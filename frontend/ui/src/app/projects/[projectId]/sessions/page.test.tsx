// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ useSessions: vi.fn() }));

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1" }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/layout/app-layout", () => ({
  useLayout: () => ({ setHideAiButton: vi.fn() }),
}));

vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ isPending: false }),
}));

vi.mock("@/lib/hooks/use-list-page-state", () => ({
  useListPageState: () => ({
    state: { dateFilter: { id: "7d" }, customStartDate: null, customEndDate: null, keyword: "" },
    queryOptions: { page: 1, limit: 50 },
    updateDateFilter: vi.fn(),
    updateCustomRange: vi.fn(),
    updateKeyword: vi.fn(),
    updateLimit: vi.fn(),
    goToPage: vi.fn(),
  }),
}));

vi.mock("@/features/traces/hooks", () => ({
  useSessions: (...args: unknown[]) => mocks.useSessions(...args),
}));

const emptySessions = {
  data: { data: [], meta: { total: 0 } },
  isPending: false,
  error: null,
  refetch: vi.fn(),
};

const twoSessions = {
  data: {
    data: [
      { session_id: "sess-1", first_trace_time: null, user_ids: [], trace_count: 2 },
      { session_id: "sess-2", first_trace_time: null, user_ids: ["user-a"], trace_count: 1 },
    ],
    meta: { total: 2 },
  },
  isPending: false,
  error: null,
  refetch: vi.fn(),
};

vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));
vi.mock("@/lib/hooks/use-retention", () => ({
  useRetention: () => ({
    retentionDays: 15,
    showPricing: false,
    onUpgradeClick: vi.fn(),
    closePricing: vi.fn(),
    workspaceId: "ws-1",
    billingPlan: "free",
  }),
}));
vi.mock("@/ee/features/billing/PricingDialog", () => ({ PricingDialog: () => null }));
vi.mock("@/components/search-filter-bar", () => ({ SearchFilterBar: () => null }));
vi.mock("@/components/list-pagination", () => ({ ListPagination: () => null }));
vi.mock("@/features/traces/components/SessionDetailPanel", () => ({
  SessionDetailPanel: () => null,
}));

import SessionsPage from "./page";

mocks.useSessions.mockReturnValue(emptySessions);

afterEach(() => {
  cleanup();
  mocks.useSessions.mockReset();
  mocks.useSessions.mockReturnValue(emptySessions);
});

describe("SessionsPage", () => {
  it("shows the nav tabs and the no-sessions empty state", () => {
    render(<SessionsPage />);

    expect(screen.getByText("Traces")).toBeTruthy();
    expect(screen.getByText("Users")).toBeTruthy();
    expect(screen.getByText("Sessions")).toBeTruthy();
    expect(screen.getByText("No sessions found")).toBeTruthy();
  });

  it("marks only the clicked row as the selected one", () => {
    mocks.useSessions.mockReturnValue(twoSessions);

    render(<SessionsPage />);

    const rowFor = (id: string) => screen.getByText(id).closest("tr") as HTMLTableRowElement;
    expect(rowFor("sess-1").dataset.selected).toBeUndefined();
    expect(rowFor("sess-2").dataset.selected).toBeUndefined();

    fireEvent.click(rowFor("sess-2"));

    expect(rowFor("sess-2").dataset.selected).toBe("true");
    expect(rowFor("sess-2").className).toContain("bg-muted");
    expect(rowFor("sess-1").dataset.selected).toBeUndefined();
  });

  it("shows the error state with the session-auth hint and a retry", () => {
    const refetch = vi.fn();
    mocks.useSessions.mockReturnValue({
      data: undefined,
      isPending: false,
      error: new Error("boom"),
      refetch,
    });

    render(<SessionsPage />);

    const title = screen.getByText("Error loading sessions");
    expect(title.className).toContain("text-destructive");
    expect(screen.getByText("Make sure the API server is running.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refetch).toHaveBeenCalled();
  });
});

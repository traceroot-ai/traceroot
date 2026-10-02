// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { signalDeepLinkPath } from "@traceroot/core/signals";

// The query of the link a notification sends for signal s1 of project p1.
const linkQuery = vi.hoisted(() => ({ value: "" }));

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1" }),
  useSearchParams: () => new URLSearchParams(linkQuery.value),
}));
vi.mock("@/lib/hooks/use-list-page-state", () => ({
  useListPageState: () => ({
    state: { dateFilter: { id: "7d" }, customStartDate: null, customEndDate: null, filters: [] },
    queryOptions: { page: 0, limit: 50, filters: [] },
    updateFilters: vi.fn(),
    updateDateFilter: vi.fn(),
    updateCustomRange: vi.fn(),
    updateLimit: vi.fn(),
    goToPage: vi.fn(),
  }),
}));
vi.mock("@/lib/hooks/use-retention", () => ({
  useRetention: () => ({ retentionDays: null, showPricing: false, billingPlan: "free" }),
}));
vi.mock("@/components/layout/app-layout", () => ({
  useLayout: () => ({ sidebarCollapsed: false }),
}));
vi.mock("@/features/detectors/hooks/use-detectors", () => ({
  useDetectorList: () => ({ data: { data: [] } }),
}));
vi.mock("@/ee/features/signals/hooks", () => ({
  useSignals: () => ({
    data: { data: [], meta: { page: 0, limit: 50, total: 0 } },
    isLoading: false,
    error: null,
  }),
}));
// The panel opens one signal by id; the stub shows which.
vi.mock("@/ee/features/signals/components/signal-detail-panel", () => ({
  SignalDetailPanel: ({ signalId }: { signalId: string }) => (
    <div data-testid="signal-panel">{signalId}</div>
  ),
}));
vi.mock("@/features/traces/components/TraceViewerPanel", () => ({ TraceViewerPanel: () => null }));
vi.mock("@/ee/features/billing/PricingDialog", () => ({ PricingDialog: () => null }));
vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));
vi.mock("@/features/filters/trace-search-filter-input", () => ({
  TraceSearchFilterInput: () => null,
}));
vi.mock("@/components/date-filter-select", () => ({ DateFilterSelect: () => null }));
vi.mock("@/components/list-pagination", () => ({ ListPagination: () => null }));

import SignalsPage from "./page";

afterEach(cleanup);

describe("Signals page route contract", () => {
  it("opens the signal a notification links to", () => {
    const [path, query] = signalDeepLinkPath("p1", "s1").split("?");
    // The link's path is this page's route.
    expect(path).toBe("/projects/p1/signals");
    linkQuery.value = query;
    render(<SignalsPage />);
    expect(screen.getByTestId("signal-panel").textContent).toBe("s1");
  });

  it("opens no signal without the parameter", () => {
    linkQuery.value = "";
    render(<SignalsPage />);
    expect(screen.queryByTestId("signal-panel")).toBeNull();
  });
});

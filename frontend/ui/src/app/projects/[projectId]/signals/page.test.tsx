// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { signalDeepLinkPath } from "@traceroot/core/signals";

// The query of the link a notification sends for signal s1 of project p1.
const linkQuery = vi.hoisted(() => ({ value: "" }));
const list = vi.hoisted(() => ({
  filters: [] as unknown[],
  updateFilters: vi.fn(),
  setup: undefined as unknown,
  setupEnabled: [] as boolean[],
}));
const detectorNames = vi.hoisted(() => ({ data: [] as { id: string; name: string }[] }));
// Captures the filter fields the page builds, to check the Detector field's options.
const filterInput = vi.hoisted(() => ({ fields: undefined as unknown }));

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1" }),
  useSearchParams: () => new URLSearchParams(linkQuery.value),
}));
vi.mock("@/lib/hooks/use-list-page-state", () => ({
  useListPageState: () => ({
    state: {
      dateFilter: { id: "7d" },
      customStartDate: null,
      customEndDate: null,
      filters: list.filters,
    },
    queryOptions: { page: 0, limit: 50, filters: list.filters },
    updateFilters: list.updateFilters,
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
  useAllDetectorNames: () => ({ data: detectorNames.data }),
}));
vi.mock("@/ee/features/signals/hooks", () => ({
  useSignals: () => ({
    data: { data: [], meta: { page: 0, limit: 50, total: 0 } },
    isLoading: false,
    error: null,
  }),
  useSignalSetup: (_projectId: string, enabled: boolean) => {
    list.setupEnabled.push(enabled);
    return list.setup === undefined
      ? { data: undefined, isPending: true, error: null, refetch: vi.fn() }
      : { data: list.setup, isPending: false, error: null, refetch: vi.fn() };
  },
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
  TraceSearchFilterInput: (props: { fields: unknown }) => {
    filterInput.fields = props.fields;
    return null;
  },
}));
vi.mock("@/components/date-filter-select", () => ({ DateFilterSelect: () => null }));
vi.mock("@/components/list-pagination", () => ({ ListPagination: () => null }));

import SignalsPage from "./page";

afterEach(() => {
  cleanup();
  list.filters = [];
  list.updateFilters.mockReset();
  list.setup = undefined;
  list.setupEnabled = [];
  linkQuery.value = "";
  detectorNames.data = [];
  filterInput.fields = undefined;
});

const setup = (over: Record<string, number> = {}) => ({
  signalCount: 0,
  detectorCount: 0,
  signalDetectorCount: 0,
  sampledSignalDetectorCount: 0,
  grouping: true,
  ...over,
});

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

describe("Signals page with nothing listed", () => {
  it("reads the project's setup only once the list is empty", () => {
    render(<SignalsPage />);
    expect(list.setupEnabled.at(-1)).toBe(true);
  });

  it("guides a project without signals to set up a detector", () => {
    list.setup = setup();
    render(<SignalsPage />);
    expect(screen.getByRole("heading", { name: "No signals yet" })).toBeTruthy();
    const link = screen.getByRole("link", { name: "Create detector" });
    expect(link.getAttribute("href")).toBe("/projects/p1/detectors/new");
    expect(screen.queryByText("No signals match your filters.")).toBeNull();
  });

  it("says nothing matches, and clears the filters, when the project has signals", () => {
    list.setup = setup({ signalCount: 3, detectorCount: 1, signalDetectorCount: 1 });
    list.filters = [{ field: "status", op: "in", value: ["open"] }];
    render(<SignalsPage />);
    expect(screen.getByText("No signals match your filters.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(list.updateFilters).toHaveBeenCalledWith([]);
  });

  it("still opens a linked signal that the filters hide", () => {
    list.setup = setup({ signalCount: 1, detectorCount: 1, signalDetectorCount: 1 });
    linkQuery.value = signalDeepLinkPath("p1", "s1").split("?")[1];
    render(<SignalsPage />);
    expect(screen.getByTestId("signal-panel").textContent).toBe("s1");
  });
});

describe("Signals page detector filter options", () => {
  it("builds the Detector name filter from every detector name, deduped and sorted", () => {
    // useAllDetectorNames pages through the list endpoint (tested with its
    // hook); the page only turns the names it returns into sorted, unique
    // options.
    detectorNames.data = [
      { id: "d1", name: "Beta" },
      { id: "d2", name: "alpha" },
      { id: "d3", name: "Beta" },
    ];
    render(<SignalsPage />);
    const fields = filterInput.fields as Array<{
      field: string;
      label: string;
      enum_values?: string[];
    }>;
    expect(fields.map((f) => f.label)).toEqual([
      "Signal ID",
      "Signal name",
      "Detector ID",
      "Detector name",
      "Status",
    ]);
    const detectorField = fields.find((f) => f.field === "detector");
    expect(detectorField?.enum_values).toEqual(["alpha", "Beta"]);
  });
});

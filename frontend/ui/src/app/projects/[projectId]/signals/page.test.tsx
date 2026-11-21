// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { signalDeepLinkPath } from "@traceroot/core/signals";

// The query of the link a notification sends for signal s1 of project p1.
const linkQuery = vi.hoisted(() => ({ value: "" }));
const navigation = vi.hoisted(() => ({ push: vi.fn() }));
const list = vi.hoisted(() => ({
  filters: [] as unknown[],
  updateFilters: vi.fn(),
  setup: undefined as unknown,
  setupEnabled: [] as boolean[],
  dateFilter: { id: "7d", isCustom: false },
  customStartDate: null as Date | null,
  customEndDate: null as Date | null,
  meta: { page: 0, limit: 50, total: 0 },
  rows: [] as unknown[],
}));
const detectorNames = vi.hoisted(() => ({ data: [] as { id: string; name: string }[] }));
const loopList = vi.hoisted(() => ({
  data: undefined as { data: { id: string; name: string }[] } | undefined,
  useLoopList: vi.fn(),
  enabled: true,
}));
// Captures the filter fields the page builds, to check the Detector field's options.
const filterInput = vi.hoisted(() => ({ fields: undefined as unknown }));

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1" }),
  useSearchParams: () => new URLSearchParams(linkQuery.value),
  useRouter: () => navigation,
}));
vi.mock("@/lib/hooks/use-list-page-state", () => ({
  useListPageState: () => ({
    state: {
      dateFilter: list.dateFilter,
      customStartDate: list.customStartDate,
      customEndDate: list.customEndDate,
      filters: list.filters,
      page: 2,
      limit: 100,
    },
    queryOptions: { page: 2, limit: 100, filters: list.filters },
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
  useLayout: () => ({ sidebarCollapsed: false, loopsEnabled: loopList.enabled }),
}));
vi.mock("@/features/detectors/hooks/use-detectors", () => ({
  useAllDetectorNames: () => ({ data: detectorNames.data }),
}));
vi.mock("@/features/loops/hooks/use-loops", () => ({
  useLoopList: (...args: unknown[]) => {
    loopList.useLoopList(...args);
    return { data: loopList.data };
  },
}));
vi.mock("@/ee/features/signals/hooks", () => ({
  useSignals: () => ({
    data: { data: list.rows, meta: list.meta },
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
  SignalDetailPanel: ({
    signalId,
    tracesHref,
    onOpenTrace,
  }: {
    signalId: string;
    tracesHref: string;
    onOpenTrace: (traceId: string) => void;
  }) => (
    <div data-testid="signal-panel">
      {signalId}
      <a href={tracesHref}>View all</a>
      <button onClick={() => onOpenTrace("trace-1")}>Open affected trace</button>
    </div>
  ),
}));
vi.mock("@/ee/features/billing/PricingDialog", () => ({ PricingDialog: () => null }));
vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));
vi.mock("@/features/filters/trace-search-filter-input", () => ({
  TraceSearchFilterInput: (props: { fields: unknown }) => {
    filterInput.fields = props.fields;
    return null;
  },
}));
vi.mock("@/components/date-filter-select", () => ({ DateFilterSelect: () => null }));
vi.mock("@/components/list-pagination", () => ({
  ListPagination: ({ page, limit }: { page: number; limit: number }) => (
    <div data-testid="pager">{`page ${page} limit ${limit}`}</div>
  ),
}));

import SignalsPage from "./page";

afterEach(() => {
  cleanup();
  list.filters = [];
  list.updateFilters.mockReset();
  list.setup = undefined;
  list.setupEnabled = [];
  linkQuery.value = "";
  detectorNames.data = [];
  loopList.data = undefined;
  loopList.useLoopList.mockClear();
  loopList.enabled = true;
  filterInput.fields = undefined;
  navigation.push.mockReset();
  list.dateFilter = { id: "7d", isCustom: false };
  list.customStartDate = null;
  list.customEndDate = null;
  list.meta = { page: 0, limit: 50, total: 0 };
  list.rows = [];
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
    expect(screen.getByTestId("signal-panel").textContent).toContain("s1");
  });

  it("opens no signal without the parameter", () => {
    linkQuery.value = "";
    render(<SignalsPage />);
    expect(screen.queryByTestId("signal-panel")).toBeNull();
  });
});

describe("Signals page affected trace navigation", () => {
  it.each([false, true])(
    "opens Tracing with the signal and trace, custom range: %s",
    (isCustom) => {
      linkQuery.value = "signalId=s1";
      list.dateFilter = { id: isCustom ? "custom" : "7d", isCustom };
      if (isCustom) {
        list.customStartDate = new Date("2026-10-01T00:00:00Z");
        list.customEndDate = new Date("2026-10-03T12:00:00Z");
      }
      render(<SignalsPage />);
      const viewAllUrl = new URL(
        screen.getByRole("link", { name: "View all" }).getAttribute("href")!,
        "http://localhost",
      );

      fireEvent.click(screen.getByRole("button", { name: "Open affected trace" }));

      const target = new URL(navigation.push.mock.calls[0][0], "http://localhost");
      expect(target.pathname).toBe("/projects/p1/traces");
      expect(target.searchParams.get("traceId")).toBe("trace-1");
      expect(JSON.parse(target.searchParams.get("filters")!)).toEqual([
        { field: "signal_id", op: "eq", value: "s1" },
      ]);
      expect(target.searchParams.get("date_filter")).toBe(isCustom ? "custom" : "7d");
      if (isCustom) {
        expect(target.searchParams.get("start")).toBe("2026-10-01T00:00:00.000Z");
        expect(target.searchParams.get("end")).toBe("2026-10-03T12:00:00.000Z");
      }
      target.searchParams.delete("traceId");
      expect(target.href).toBe(viewAllUrl.href);
    },
  );
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
    expect(screen.getByTestId("signal-panel").textContent).toContain("s1");
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
      "Loop",
      "Status",
    ]);
    const detectorField = fields.find((f) => f.field === "detector");
    expect(detectorField?.enum_values).toEqual(["alpha", "Beta"]);
    // No Loops loaded yet: the Loop chip has no options rather than failing.
    expect(fields.find((f) => f.field === "loop")?.enum_values).toEqual([]);
  });

  it("offers every Loop by name, sorted, for the Loop filter", () => {
    loopList.data = {
      data: [
        { id: "l2", name: "Coding agents" },
        { id: "l1", name: "Checkout watch" },
      ],
    };
    render(<SignalsPage />);
    expect(loopList.useLoopList).toHaveBeenCalledWith("p1", { limit: 5 }, { enabled: true });
    const fields = filterInput.fields as Array<{
      field: string;
      type: string;
      operators: string[];
      enum_values?: string[];
    }>;
    expect(fields.find((f) => f.field === "loop")).toMatchObject({
      type: "categorical",
      operators: ["in"],
      enum_values: ["Checkout watch", "Coding agents"],
    });
  });
});

describe("Signals page with loops switched off", () => {
  it("leaves out the Loop filter and does not ask for the loops", () => {
    loopList.enabled = false;
    render(<SignalsPage />);
    const fields = filterInput.fields as Array<{ field: string }>;
    expect(fields.map((f) => f.field)).not.toContain("loop");
    expect(loopList.useLoopList).toHaveBeenCalledWith("p1", { limit: 5 }, { enabled: false });
  });
});

describe("Signals page pagination", () => {
  it("drives the pager from the client page state, not the server's echo", () => {
    // meta.page/limit are the previous query's echo while placeholder data is shown.
    list.meta = { page: 0, limit: 50, total: 500 };
    render(<SignalsPage />);
    expect(screen.getByTestId("pager").textContent).toBe("page 2 limit 100");
  });
});

describe("Signals page provenance", () => {
  const row = (
    id: string,
    detectorId: string,
    detectorName: string | null,
    loop: { id: string; name: string } | null = null,
  ) => ({
    id,
    detectorId,
    detectorName,
    source: loop
      ? { kind: "loop", ...loop, detectorId }
      : { kind: "detector", id: detectorId, name: detectorName },
    title: `Signal ${id}`,
    status: "open",
    hitCount: 2,
    rangeHitCount: 2,
    createTime: "2026-11-11T09:00:00Z",
  });
  const deletedLoop = (detectorId: string) => ({ kind: "deletedLoop", detectorId });

  it("shows the Loop that found a signal, linking to it, and a detector's name for the rest", () => {
    list.rows = [
      row("s1", "det-loop", null, { id: "loop-1", name: "Coding agents" }),
      row("s2", "det-1", "Failures"),
    ];
    list.meta = { page: 0, limit: 50, total: 2 };
    render(<SignalsPage />);

    const found = screen.getByRole("link", { name: /Found by loop Coding agents/ });
    expect(found.getAttribute("href")).toBe("/projects/p1/loops/loop-1");
    // The hidden detector's own name is not shown for it; the other signal keeps its detector.
    expect(screen.queryByText("loop:Coding agents")).toBeNull();
    expect(screen.getByText("Failures")).toBeTruthy();
    // The in-house headers stay: the Loop shows in the Detector name column.
    expect(screen.getByRole("columnheader", { name: "Detector name" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Affected traces" })).toBeTruthy();
    // The Detector ID column shows no hidden detector's ID for a Loop: the name cell links it.
    expect(screen.queryByText("det-loop")).toBeNull();
    expect(screen.queryByRole("link", { name: /Open loop/ })).toBeNull();
    expect(screen.getByRole("link", { name: "Open detector Failures" }).getAttribute("href")).toBe(
      "/projects/p1/detectors/det-1",
    );
  });

  it("says a deleted Loop found a signal, muted and with no link", () => {
    list.rows = [{ ...row("s1", "det-gone", null), source: deletedLoop("det-gone") }];
    list.meta = { page: 0, limit: 50, total: 1 };
    render(<SignalsPage />);
    const name = screen.getByText("Deleted loop");
    expect(name.className).toContain("text-muted-foreground");
    expect(name.closest("a")).toBeNull();
    expect(screen.queryByText("det-gone")).toBeNull();
    expect(screen.queryByRole("link", { name: /Found by loop|Open detector/ })).toBeNull();
    // Its hits are still the examples its runs cited.
    expect(screen.getByRole("link", { name: "View example traces for Signal s1" })).toBeTruthy();
  });

  it("keeps the IDs from xl, and truncates long names so Status stays in view", () => {
    const long = "A very long Loop name that would otherwise push Status off the screen";
    list.rows = [
      row("s1", "det-loop", null, { id: "loop-1", name: long }),
      row("s2", "det-1", `Detector ${long}`),
    ];
    list.meta = { page: 0, limit: 50, total: 2 };
    render(<SignalsPage />);
    for (const name of ["Signal ID", "Detector ID"]) {
      const th = screen.getByRole("columnheader", { name });
      expect(th.className).toContain("hidden");
      expect(th.className).toMatch(/(^| )xl:table-cell/);
    }
    const found = screen.getByRole("link", { name: `Found by loop ${long}` });
    expect(found.className).toContain("max-w-[12rem]");
    expect(found.getAttribute("title")).toBe(`Found by loop ${long}`);
    expect(found.querySelector(".truncate")?.textContent).toBe(`Found by loop ${long}`);
    const detector = screen.getByText(`Detector ${long}`);
    expect(detector.className).toContain("truncate");
    expect(detector.getAttribute("title")).toBe(`Detector ${long}`);
    expect(screen.getByText("Signal s1").className).toContain("truncate");
  });

  it("counts a Loop's cited examples as a bare number, like a detector's affected traces", () => {
    list.rows = [
      row("s1", "det-loop", null, { id: "loop-1", name: "Coding agents" }),
      row("s2", "det-1", "Failures"),
    ];
    list.meta = { page: 0, limit: 50, total: 2 };
    render(<SignalsPage />);
    const examples = screen.getByRole("link", { name: "View example traces for Signal s1" });
    expect(examples.textContent).toBe("2");
    expect(examples.getAttribute("title")).toBe("View example traces for Signal s1");
    const affected = screen.getByRole("link", { name: "View affected traces for Signal s2" });
    expect(affected.textContent).toBe("2");
  });

  it("heads the count Example traces, as the panel does, only while filtered to a Loop", () => {
    // Every row a Loop's, but no Loop filter: the header follows the query, not the page.
    list.rows = [
      row("s1", "det-loop", null, { id: "loop-1", name: "Coding agents" }),
      { ...row("s2", "det-gone", null), source: deletedLoop("det-gone") },
    ];
    list.meta = { page: 0, limit: 50, total: 2 };
    const { unmount } = render(<SignalsPage />);
    expect(screen.getByRole("columnheader", { name: "Affected traces" })).toBeTruthy();
    unmount();
    list.filters = [{ field: "loop", op: "in", value: ["Coding agents"] }];
    render(<SignalsPage />);
    expect(screen.getByRole("columnheader", { name: "Example traces" })).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "Affected traces" })).toBeNull();
  });

  it("names a Loop without linking to it where loops are switched off", () => {
    loopList.enabled = false;
    list.rows = [row("s1", "det-loop", null, { id: "loop-1", name: "Coding agents" })];
    list.meta = { page: 0, limit: 50, total: 1 };
    render(<SignalsPage />);
    expect(screen.getByText("Found by loop Coding agents")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Found by loop/ })).toBeNull();
  });
});

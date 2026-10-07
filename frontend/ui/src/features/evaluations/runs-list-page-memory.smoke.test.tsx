// @vitest-environment jsdom
/**
 * The Evaluations runs list keeps its page and date window across opening a run and
 * coming back: both live in the URL, and the run detail links back to the list query
 * it was opened from.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";

const nav = vi.hoisted(() => ({
  search: "",
  replace: vi.fn(),
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1" }),
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  useSearchParams: () => new URLSearchParams(nav.search),
  usePathname: () => "/projects/p1/evaluations",
}));
vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));
// The real range picker is a calendar widget; stub it with a button that applies a
// fixed range so the custom-range URL write can be exercised.
const APPLIED_START = new Date("2026-07-01T00:00:00Z");
const APPLIED_END = new Date("2026-07-04T00:00:00Z");
vi.mock("@/components/ui/date-time-picker", () => ({
  DateRangePicker: ({ onApply }: { onApply: (start: Date | null, end: Date | null) => void }) => (
    <button type="button" onClick={() => onApply(APPLIED_START, APPLIED_END)}>
      Apply stub range
    </button>
  ),
}));

import { EvaluationsView } from "./views/evaluations-view";
import { RunDetailView } from "./views/run-detail-view";

const run = (n: number) => ({
  id: `run${n}`,
  evaluationId: "eval1",
  datasetId: "ds1",
  datasetVersionId: "dv1",
  runNumber: n,
  candidateVersion: `git:${n}`,
  status: "completed",
  caseCount: 1,
  startedAt: "2026-07-17T10:24:00Z",
  evaluationName: "Billing routing",
  datasetName: "Billing routing",
  datasetVersionLabel: "v1",
});

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  nav.search = "";
  nav.replace.mockReset();
  sessionStorage.clear();
  fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes("/evaluation-runs/") || /\/runs\/run/.test(u)) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [run(1)], meta: { page: 1, limit: 50, total: 120 } }),
    };
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => cleanup());

const clients = new WeakMap<object, QueryClient>();
const qcFor = (view: object) => clients.get(view)!;

function mount(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <ToastProvider>{node}</ToastProvider>
    </QueryClientProvider>,
  );
  clients.set(view, qc);
  return view;
}

const runsRequests = () =>
  fetchMock.mock.calls
    .map(([url]) => new URL(String(url), "http://x"))
    .filter((u) => u.pathname.endsWith("/evaluations/runs"));
const lastRunsRequest = () => runsRequests().at(-1)!.searchParams;

const requestedPages = () =>
  fetchMock.mock.calls
    .map(([url]) => new URL(String(url), "http://x").searchParams.get("page"))
    .filter((p): p is string => p !== null);

describe("runs list page memory", () => {
  it("opens on the page held in the URL and does not reset it on mount", async () => {
    nav.search = "page_index=1";
    mount(<EvaluationsView projectId="p1" />);
    expect(await screen.findByText(/Showing 51–100 of 120/)).toBeDefined();
    expect(requestedPages()).not.toContain("0");
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("writes the page to the URL when paging", async () => {
    mount(<EvaluationsView projectId="p1" />);
    fireEvent.click(await screen.findByLabelText("Next page"));
    expect(nav.replace).toHaveBeenCalledWith("/projects/p1/evaluations?page_index=1", {
      scroll: false,
    });
  });

  it("restores the date window from the URL alongside the page", async () => {
    nav.search = "date_filter=30d&page_index=1";
    const before = Date.now();
    mount(<EvaluationsView projectId="p1" />);
    expect(await screen.findByText("Last 30 days")).toBeDefined();
    expect(await screen.findByText(/Showing 51–100 of 120/)).toBeDefined();
    expect(nav.replace).not.toHaveBeenCalled();
    // The restored preset is what bounds the request, not just the trigger label.
    const startedAfter = Date.parse(lastRunsRequest().get("started_after")!);
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    expect(startedAfter).toBeGreaterThanOrEqual(before - thirtyDaysMs);
    expect(startedAfter).toBeLessThanOrEqual(Date.now() - thirtyDaysMs);
    expect(lastRunsRequest().get("started_before")).toBeNull();
  });

  it("restores a custom range from the URL into the request bounds", async () => {
    nav.search = `date_filter=custom&start=${APPLIED_START.toISOString()}&end=${APPLIED_END.toISOString()}`;
    mount(<EvaluationsView projectId="p1" />);
    await screen.findByText(/of 120/);
    expect(lastRunsRequest().get("started_after")).toBe(APPLIED_START.toISOString());
    expect(lastRunsRequest().get("started_before")).toBe(APPLIED_END.toISOString());
  });

  it.each([
    ["no bounds", "date_filter=custom"],
    ["one bound", `date_filter=custom&start=${APPLIED_START.toISOString()}`],
    ["an unparseable bound", "date_filter=custom&start=garbage&end=2026-07-04T00:00:00Z"],
    [
      "reversed bounds",
      `date_filter=custom&start=${APPLIED_END.toISOString()}&end=${APPLIED_START.toISOString()}`,
    ],
  ])("falls back to the default window for a custom URL with %s", async (_label, search) => {
    nav.search = search;
    const before = Date.now();
    mount(<EvaluationsView projectId="p1" />);
    expect(await screen.findByText("Last 14 days")).toBeDefined();
    await screen.findByText(/of 120/);
    const startedAfter = Date.parse(lastRunsRequest().get("started_after")!);
    const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
    expect(startedAfter).toBeGreaterThanOrEqual(before - fourteenDaysMs);
    expect(lastRunsRequest().get("started_before")).toBeNull();
  });

  it("applying a custom range writes the URL once, with both bounds", async () => {
    nav.search = "page_index=2";
    mount(<EvaluationsView projectId="p1" />);
    fireEvent.click(await screen.findByText("Last 14 days"));
    fireEvent.click(await screen.findByRole("button", { name: "Custom" }));
    fireEvent.click(await screen.findByRole("button", { name: "Apply stub range" }));
    expect(nav.replace).toHaveBeenCalledTimes(1);
    const written = new URL(String(nav.replace.mock.calls[0][0]), "http://x").searchParams;
    expect(written.get("date_filter")).toBe("custom");
    expect(written.get("start")).toBe(APPLIED_START.toISOString());
    expect(written.get("end")).toBe(APPLIED_END.toISOString());
    expect(written.get("page_index")).toBeNull();
  });

  it("does not clamp the page against the previous query's total while the new one loads", async () => {
    // First query: 30 runs (one page). The URL then moves to page 3 of a wider
    // window whose response is still in flight, so the table shows placeholder rows
    // from the 30-run query. Clamping against that stale total would drop the page.
    let releaseWide: () => void = () => {};
    fetchMock.mockImplementation(async (url: RequestInfo | URL) => {
      const u = new URL(String(url), "http://x");
      if (u.searchParams.get("page") === "2") {
        await new Promise<void>((r) => (releaseWide = r));
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [run(1)], meta: { page: 3, limit: 50, total: 160 } }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [run(1)], meta: { page: 1, limit: 50, total: 30 } }),
      };
    });
    // Let URL writes land, as the real router would, so a clamp can't loop.
    nav.replace.mockImplementation((url: string) => {
      nav.search = new URL(url, "http://x").search.slice(1);
    });
    const view = mount(<EvaluationsView projectId="p1" />);
    await screen.findByText(/of 30/);
    nav.search = "date_filter=90d&page_index=2";
    view.rerender(
      <QueryClientProvider client={qcFor(view)}>
        <ToastProvider>
          <EvaluationsView projectId="p1" />
        </ToastProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(requestedPages()).toContain("2"));
    expect(nav.replace).not.toHaveBeenCalled();
    releaseWide();
    expect(await screen.findByText(/Showing 101–150 of 160/)).toBeDefined();
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("changing the date window writes it to the URL and drops the page", async () => {
    nav.search = "page_index=2";
    mount(<EvaluationsView projectId="p1" />);
    fireEvent.click(await screen.findByText("Last 14 days"));
    fireEvent.click(await screen.findByText("Last 7 days"));
    expect(nav.replace).toHaveBeenCalledWith("/projects/p1/evaluations?date_filter=7d", {
      scroll: false,
    });
  });

  it("the run detail links back to the list query it was opened from", async () => {
    nav.search = "page_index=1";
    mount(<EvaluationsView projectId="p1" />);
    await screen.findByText(/Showing 51–100 of 120/);
    cleanup();

    mount(<RunDetailView projectId="p1" runId="run1" />);
    const back = await screen.findByText("Back to evaluations");
    await waitFor(() =>
      expect(back.getAttribute("href")).toBe("/projects/p1/evaluations?page_index=1"),
    );
  });

  it("the run detail links to the bare list when no list query was recorded", async () => {
    mount(<RunDetailView projectId="p1" runId="run1" />);
    const back = await screen.findByText("Back to evaluations");
    expect(back.getAttribute("href")).toBe("/projects/p1/evaluations");
  });
});

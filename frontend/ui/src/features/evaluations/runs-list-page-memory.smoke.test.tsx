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
  nav.replace.mockClear();
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

function mount(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>{node}</ToastProvider>
    </QueryClientProvider>,
  );
}

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
    mount(<EvaluationsView projectId="p1" />);
    expect(await screen.findByText("Last 30 days")).toBeDefined();
    expect(await screen.findByText(/Showing 51–100 of 120/)).toBeDefined();
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

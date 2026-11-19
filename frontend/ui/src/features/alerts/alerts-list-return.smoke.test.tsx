// @vitest-environment jsdom
/**
 * The alerts list keeps its page across opening an alert and coming back: the page
 * lives in the URL, and the alert pages' Back links return to the list query they
 * were opened from rather than the first page.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const nav = vi.hoisted(() => {
  const state = {
    search: "",
    replace: vi.fn(),
    push: vi.fn(),
    // One instance per query string, as Next returns: the list's URL-filter hooks
    // re-sync on a new identity, so a fresh object each render never settles.
    params: new URLSearchParams(),
    paramsFor: "",
    searchParams() {
      if (state.paramsFor !== state.search) {
        state.params = new URLSearchParams(state.search);
        state.paramsFor = state.search;
      }
      return state.params;
    },
  };
  return state;
});

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1" }),
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  useSearchParams: () => nav.searchParams(),
  usePathname: () => "/projects/p1/alerts",
}));
vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));
vi.mock("@/features/alerts/components/alert-form", () => ({ AlertForm: () => null }));

import AlertsPage from "@/app/projects/[projectId]/alerts/page";
import NewAlertPage from "@/app/projects/[projectId]/alerts/new/page";
import { EditAlertPage } from "./components/edit-alert-page";

const alertRow = {
  id: "alert-1",
  name: "P95 latency",
  view: "SPANS",
  measure: "latency",
  aggregation: "p95",
  window: "10m",
  thresholdOperator: ">",
  threshold: 500,
  status: "ACTIVE",
  severity: "OK",
  severityChangedAt: null,
  alertedAt: null,
  lastEvaluatedAt: null,
  lastError: null,
  lastErrorAt: null,
  lastNotifyStatus: null,
  lastNotifyError: null,
  lastNotifyAt: null,
  createTime: "2026-07-01T00:00:00.000Z",
  updateTime: "2026-07-01T00:00:00.000Z",
  creator: "Ada",
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  nav.search = "";
  nav.replace.mockClear();
  sessionStorage.clear();
  fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    // A single alert: answered 404 so the edit page renders its header and stops there.
    if (/\/alerts\/[^/?]+$/.test(u)) {
      return { ok: false, status: 404, json: async () => ({ detail: "Not found" }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: [alertRow],
        meta: { page: 2, limit: 10, total: 30, capacity: { used: 30, max: 100 } },
      }),
    };
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => cleanup());

function mount(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

const alertsBackLink = () => screen.getByRole("link", { name: "Alerts" });

async function openListOn(search: string) {
  nav.search = search;
  mount(<AlertsPage />);
  expect(await screen.findByText("P95 latency")).toBeDefined();
  cleanup();
}

describe("alerts list page memory", () => {
  it("requests the page held in the URL and does not reset it on mount", async () => {
    await openListOn("page_index=2&page_limit=10");
    const pages = fetchMock.mock.calls
      .map(([url]) => new URL(String(url), "http://x").searchParams)
      .filter((p) => p.get("limit") === "10")
      .map((p) => p.get("page"));
    expect(pages).toContain("2");
    expect(pages).not.toContain("0");
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("the edit page links back to the list page it was opened from", async () => {
    await openListOn("page_index=2&page_limit=10");
    mount(<EditAlertPage projectId="p1" alertId="alert-1" />);
    await waitFor(() =>
      expect(alertsBackLink().getAttribute("href")).toBe(
        "/projects/p1/alerts?page_index=2&page_limit=10",
      ),
    );
  });

  it("the new alert page links back to the list page it was opened from", async () => {
    await openListOn("page_index=2&page_limit=10");
    mount(<NewAlertPage />);
    await waitFor(() =>
      expect(alertsBackLink().getAttribute("href")).toBe(
        "/projects/p1/alerts?page_index=2&page_limit=10",
      ),
    );
  });

  it("returning to the first page clears the remembered page", async () => {
    await openListOn("page_index=2&page_limit=10");
    await openListOn("");
    mount(<EditAlertPage projectId="p1" alertId="alert-1" />);
    expect(alertsBackLink().getAttribute("href")).toBe("/projects/p1/alerts");
  });

  it("the edit page links to the bare list when no list page was recorded", () => {
    mount(<EditAlertPage projectId="p1" alertId="alert-1" />);
    expect(alertsBackLink().getAttribute("href")).toBe("/projects/p1/alerts");
  });
});

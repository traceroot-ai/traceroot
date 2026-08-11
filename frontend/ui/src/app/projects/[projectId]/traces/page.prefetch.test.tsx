// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

const prefetch = vi.fn();
let searchParamsValue = "";
let autoRefresh = false;
vi.mock("@/features/traces/hooks", () => ({
  useTraces: () => ({
    data: {
      data: [{ trace_id: "a", name: "n", trace_start_time: 0, error_count: 0, span_count: 1 }],
      meta: { page: 3, limit: 50, total: 500 },
    },
    isLoading: false,
    error: null,
  }),
  usePrefetchTraces: () => prefetch,
  useTracesExist: () => ({ data: { exists: true }, isPending: false }),
}));
vi.mock("@/lib/hooks/use-list-page-state", () => ({
  useListPageState: () => ({
    state: {
      page: 3,
      limit: 50,
      dateFilter: "all",
      customStartDate: null,
      customEndDate: null,
      keyword: "",
    },
    page: 3,
    limit: 50,
    goToPage: vi.fn(),
    updateLimit: vi.fn(),
    updateDateFilter: vi.fn(),
    updateCustomRange: vi.fn(),
    updateKeyword: vi.fn(),
    queryOptions: { page: 3, limit: 50, start_after: "S" },
  }),
}));
// The page's live-view toggle and the trace list's column entry both persist through this
// hook, so the stub pins the toggle for the test and leaves the columns at their defaults.
vi.mock("@/lib/hooks/use-local-storage", () => ({
  useLocalStorage: () => [autoRefresh, vi.fn()],
}));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "u1", email: "e" } }, isPending: false }),
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1" }),
  useSearchParams: () => new URLSearchParams(searchParamsValue),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/layout/app-layout", () => ({
  useLayout: () => ({ setHideAiButton: vi.fn() }),
}));
vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));
vi.mock("@/features/traces/components", () => ({
  TraceViewerPanel: ({ traceId, source }: { traceId: string; source?: string }) => (
    <div data-testid="trace-panel" data-trace-id={traceId} data-source={String(source)} />
  ),
  GettingStarted: () => null,
}));
vi.mock("@/components/search-filter-bar", () => ({
  SearchFilterBar: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/features/traces/utils", () => ({ formatContentPreview: () => "" }));
vi.mock("next/link", () => ({
  default: ({ children, ...props }: { children: React.ReactNode; href: string }) => (
    <a {...props}>{children}</a>
  ),
}));

import TracesPage from "./page";

function Wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => {
  cleanup();
  prefetch.mockReset();
  autoRefresh = false;
});

describe("TracesPage prefetch wiring", () => {
  it("prefetches the next page on hover, carrying current query options", () => {
    render(<TracesPage />, { wrapper: Wrapper });
    fireEvent.mouseEnter(screen.getByRole("button", { name: /next page/i }));
    expect(prefetch).toHaveBeenCalledWith(
      expect.objectContaining({ page: 4, limit: 50, start_after: "S" }),
    );
  });

  it("does not prefetch on hover when auto-refresh is enabled", () => {
    autoRefresh = true;
    render(<TracesPage />, { wrapper: Wrapper });
    fireEvent.mouseEnter(screen.getByRole("button", { name: /next page/i }));
    expect(prefetch).not.toHaveBeenCalled();
  });
});

describe("TracesPage by-id scoping", () => {
  afterEach(() => {
    searchParamsValue = "";
  });

  it("scopes a URL-seeded traceId to customer traffic", () => {
    // A self-trace id is just the dashless run id, visible in the detector runs table,
    // so ?traceId=<run id> is trivially constructible. Without source="user" the by-id
    // read is unscoped and would render internal telemetry on the customer surface.
    searchParamsValue = "traceId=aaaaaaaabbbbccccddddeeeeeeeeeeee";
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <TracesPage />
      </QueryClientProvider>,
    );
    const panel = screen.getByTestId("trace-panel");
    expect(panel.getAttribute("data-trace-id")).toBe("aaaaaaaabbbbccccddddeeeeeeeeeeee");
    expect(panel.getAttribute("data-source")).toBe("user");
  });
});

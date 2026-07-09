// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

const prefetch = vi.fn();
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
vi.mock("@/lib/hooks/use-local-storage", () => ({ useLocalStorage: () => [autoRefresh, vi.fn()] }));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "u1", email: "e" } }, isPending: false }),
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1" }),
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/layout/app-layout", () => ({
  useLayout: () => ({ setHideAiButton: vi.fn() }),
}));
vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));
vi.mock("@/features/traces/components", () => ({
  TraceViewerPanel: () => null,
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

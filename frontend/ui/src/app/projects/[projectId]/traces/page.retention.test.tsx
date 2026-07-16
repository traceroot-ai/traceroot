// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { ApiError } from "@/lib/api/client";

const mocks = vi.hoisted(() => ({
  tracesError: null as unknown,
  tracesData: undefined as unknown,
  tracesLoading: false,
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1" }),
  useSearchParams: () => ({ get: () => null }),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ prefetchQuery: vi.fn(), invalidateQueries: vi.fn() }),
}));

vi.mock("@/components/layout/app-layout", () => ({
  useLayout: () => ({ setHideAiButton: vi.fn() }),
}));

vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "u1" } }, isPending: false }),
}));

vi.mock("@/features/traces/hooks", () => ({
  useTraces: () => ({
    data: mocks.tracesData,
    isLoading: mocks.tracesLoading,
    error: mocks.tracesError,
  }),
  usePrefetchTraces: () => vi.fn(),
  useTracesExist: () => ({ data: { exists: true }, isPending: false }),
}));

vi.mock("@/lib/hooks/use-list-page-state", () => ({
  useListPageState: () => ({
    state: {
      dateFilter: { id: "7d" },
      customStartDate: null,
      customEndDate: null,
      keyword: "",
      filters: [],
    },
    queryOptions: {},
    updateDateFilter: vi.fn(),
    updateCustomRange: vi.fn(),
    updateKeyword: vi.fn(),
    updateFilters: vi.fn(),
    updateLimit: vi.fn(),
    goToPage: vi.fn(),
  }),
}));

vi.mock("@/lib/hooks/use-local-storage", () => ({
  useLocalStorage: () => [false, vi.fn()],
}));

vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));
vi.mock("@/components/search-filter-bar", () => ({ SearchFilterBar: () => null }));
vi.mock("@/features/filters/trace-search-filter-input", () => ({
  TraceSearchFilterInput: () => null,
}));
vi.mock("@/components/list-pagination", () => ({ ListPagination: () => null }));
vi.mock("@/features/traces/components", () => ({
  TraceViewerPanel: () => null,
  GettingStarted: () => null,
}));
vi.mock("@/components/RetentionGateBanner", () => ({
  RetentionGateBanner: () => <div data-testid="retention-banner" />,
}));

import TracesPage from "./page";

afterEach(() => {
  cleanup();
  mocks.tracesError = null;
  mocks.tracesData = undefined;
  mocks.tracesLoading = false;
});

describe("TracesPage retention", () => {
  it("renders the retention banner when useTraces returns a 403 retention error", () => {
    mocks.tracesError = new ApiError(403, {
      message: "Data outside retention window",
      retention_days: 15,
      cutoff: "2026-06-29T00:00:00",
      plan: "free",
    });
    render(<TracesPage />);
    expect(screen.getByTestId("retention-banner")).toBeTruthy();
  });
});

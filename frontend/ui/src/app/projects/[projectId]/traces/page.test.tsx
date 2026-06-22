// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  setAiPanelOpen: vi.fn(),
  setAiContext: vi.fn(),
  setAiInitialSessionId: vi.fn(),
  params: {} as Record<string, string>,
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1" }),
  useSearchParams: () => ({ get: (k: string) => mocks.params[k] ?? null }),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/components/layout/app-layout", () => ({
  useLayout: () => ({
    setHideAiButton: vi.fn(),
    setAiPanelOpen: mocks.setAiPanelOpen,
    setAiContext: mocks.setAiContext,
    setAiInitialSessionId: mocks.setAiInitialSessionId,
  }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ isPending: false }),
}));

vi.mock("@/features/traces/hooks", () => ({
  useTraces: () => ({
    data: { data: [], meta: { total: 0 } },
    isLoading: false,
    isPending: false,
    error: null,
  }),
  usePrefetchTraces: () => vi.fn(),
}));

vi.mock("@/lib/hooks/use-list-page-state", () => ({
  useListPageState: () => ({
    state: {
      dateFilter: { id: "1d" },
      customStartDate: null,
      customEndDate: null,
      keyword: "",
      page: 1,
      limit: 20,
    },
    updateDateFilter: vi.fn(),
    updateCustomRange: vi.fn(),
    updateKeyword: vi.fn(),
    updateLimit: vi.fn(),
    goToPage: vi.fn(),
    queryOptions: {},
  }),
}));

vi.mock("@/lib/hooks/use-local-storage", () => ({
  useLocalStorage: () => [false, vi.fn()],
}));

vi.mock("@/features/traces/components", () => ({
  TraceViewerPanel: () => null,
  GettingStarted: () => null,
}));

vi.mock("@/features/projects/components", () => ({
  ProjectBreadcrumb: () => null,
}));

vi.mock("@/components/search-filter-bar", () => ({
  SearchFilterBar: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/list-pagination", () => ({
  ListPagination: () => null,
}));

vi.mock("@/features/traces/utils", () => ({
  formatContentPreview: (v: unknown) => String(v),
}));

vi.mock("@/lib/utils", () => ({
  formatDuration: vi.fn(),
  formatDate: vi.fn(),
  formatCost: vi.fn(),
  formatTokenFlow: vi.fn(),
  formatExactTokens: vi.fn(),
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
  buildUrlWithFilters: (path: string) => path,
}));

import TracesPage from "./page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.params = {};
});

describe("TracesPage AI panel restoration", () => {
  it("does not open AI panel when ai param is absent", async () => {
    render(<TracesPage />);
    await waitFor(() => {});
    expect(mocks.setAiPanelOpen).not.toHaveBeenCalledWith(true);
  });

  it("opens AI panel and sets context when ai=1 and traceId are in the URL", async () => {
    mocks.params = { ai: "1", traceId: "trace-1" };
    render(<TracesPage />);
    await waitFor(() => expect(mocks.setAiPanelOpen).toHaveBeenCalledWith(true));
    expect(mocks.setAiContext).toHaveBeenCalledWith({ traceId: "trace-1" });
  });

  it("restores the chat session when sessionId is also in the URL", async () => {
    mocks.params = { ai: "1", traceId: "trace-1", sessionId: "sess-42" };
    render(<TracesPage />);
    await waitFor(() => expect(mocks.setAiInitialSessionId).toHaveBeenCalledWith("sess-42"));
  });

  it("does not call setAiInitialSessionId when sessionId is absent", async () => {
    mocks.params = { ai: "1", traceId: "trace-1" };
    render(<TracesPage />);
    await waitFor(() => expect(mocks.setAiPanelOpen).toHaveBeenCalledWith(true));
    expect(mocks.setAiInitialSessionId).not.toHaveBeenCalled();
  });
});

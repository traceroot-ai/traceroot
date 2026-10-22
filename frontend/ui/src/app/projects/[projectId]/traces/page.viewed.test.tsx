// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// The page's only job in this feature is to mark a trace viewed when it is opened; the hook owns
// the storage. A spy on the hook is therefore what proves the wiring, in both directions.
//
// Two spies, one per project: the real hook rebuilds `markViewed` when `projectId` changes, and
// that identity change is exactly what the project-change test needs to reproduce.
const { markViewed, markViewedUnderNextProject } = vi.hoisted(() => ({
  markViewed: vi.fn(),
  markViewedUnderNextProject: vi.fn(),
}));

let search = "";
let project = "p1";

vi.mock("@/features/traces/hooks", () => ({
  useTraces: () => ({
    data: {
      data: [
        { trace_id: "t1", name: "n", trace_start_time: 0, error_count: 0, span_count: 1 },
        { trace_id: "t2", name: "n", trace_start_time: 0, error_count: 0, span_count: 1 },
      ],
      meta: { page: 1, limit: 50, total: 2 },
    },
    isLoading: false,
    error: null,
  }),
  useSpanIO: () => ({ data: undefined, isLoading: false, error: null }),
  useTracesExist: () => ({ data: { exists: true }, isPending: false, error: null }),
  usePrefetchTraces: () => vi.fn(),
}));
// Imported from its own module by the page (the barrel mock above would otherwise hide it).
vi.mock("@/features/traces/hooks/use-viewed-traces", () => ({
  useViewedTraces: () => ({
    viewedTraceIds: new Set<string>(),
    markViewed: project === "p1" ? markViewed : markViewedUnderNextProject,
  }),
}));
vi.mock("@/lib/hooks/use-list-page-state", () => ({
  useListPageState: () => ({
    state: { dateFilter: "all", customStartDate: null, customEndDate: null, keyword: "" },
    goToPage: vi.fn(),
    updateLimit: vi.fn(),
    updateDateFilter: vi.fn(),
    updateCustomRange: vi.fn(),
    updateKeyword: vi.fn(),
    queryOptions: { page: 1, limit: 50 },
  }),
}));
vi.mock("@/lib/hooks/use-local-storage", () => ({
  useLocalStorage: () => [false, vi.fn()],
}));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "u1", email: "e" } }, isPending: false }),
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: project }),
  useSearchParams: () => new URLSearchParams(search),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/layout/app-layout", () => ({
  useLayout: () => ({ setHideAiButton: vi.fn() }),
}));
vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));
vi.mock("@/lib/hooks/use-retention", () => ({
  useRetention: () => ({
    retentionDays: 15,
    showPricing: false,
    onUpgradeClick: vi.fn(),
    closePricing: vi.fn(),
    workspaceId: "ws-1",
    billingPlan: "free",
  }),
}));
vi.mock("@/ee/features/billing/PricingDialog", () => ({ PricingDialog: () => null }));
vi.mock("@/features/traces/components", () => ({
  TraceViewerPanel: ({ onNavigate }: { onNavigate: (d: "up" | "down") => void }) => (
    <div data-testid="trace-panel">
      <button type="button" onClick={() => onNavigate("down")}>
        panel-down
      </button>
    </div>
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

beforeEach(() => {
  markViewed.mockClear();
  markViewedUnderNextProject.mockClear();
  project = "p1";
});

afterEach(() => {
  cleanup();
  search = "";
  project = "p1";
});

describe("TracesPage marks opened traces viewed", () => {
  it("marks the ?traceId= deep-linked trace viewed on open", () => {
    search = "traceId=f1f1";

    render(<TracesPage />, { wrapper: Wrapper });

    expect(markViewed).toHaveBeenCalledWith("f1f1");
  });

  it("marks a row viewed when it is opened", () => {
    render(<TracesPage />, { wrapper: Wrapper });
    expect(markViewed).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("t1"));

    expect(markViewed).toHaveBeenCalledWith("t1");
  });

  it("marks the next trace viewed when the panel navigates to it", () => {
    render(<TracesPage />, { wrapper: Wrapper });
    // Open the first row so the panel (and its navigation control) exists.
    fireEvent.click(screen.getByText("t1"));
    markViewed.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "panel-down" }));

    expect(markViewed).toHaveBeenCalledWith("t2");
  });

  it("marks nothing while no trace is open", () => {
    render(<TracesPage />, { wrapper: Wrapper });

    expect(markViewed).not.toHaveBeenCalled();
  });

  it("does not mark the previous project's trace when the project changes", () => {
    // Only the [projectId] segment changes, so the page stays mounted and `selectedTraceId`
    // survives. The mark effect must not re-run against the new project's hook (whose `markViewed`
    // is a different function) and write the old project's trace id under the new project's key.
    const { rerender } = render(<TracesPage />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText("t1"));
    expect(markViewed).toHaveBeenCalledWith("t1");

    project = "p2";
    rerender(<TracesPage />);

    expect(markViewedUnderNextProject).not.toHaveBeenCalled();
  });

  it("marks the row again when it is opened after a project switch", () => {
    const { rerender } = render(<TracesPage />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText("t1"));
    expect(markViewed).toHaveBeenCalledWith("t1");

    project = "p2";
    rerender(<TracesPage />);
    markViewedUnderNextProject.mockClear();

    // The switch re-scopes the selection to null, so opening the same row is a new selection and
    // marks it under the new project rather than staying unread.
    fireEvent.click(screen.getByText("t1"));

    expect(markViewedUnderNextProject).toHaveBeenCalledWith("t1");
  });
});

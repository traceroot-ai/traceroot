// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { mockRetention } from "@/test/retention-mock";

// What the store holds: no trace until the first one lands, then that one.
const store = vi.hoisted(() => ({
  projectId: "p1",
  exists: false,
  traces: [] as { trace_id: string }[],
}));

vi.mock("@/features/traces/hooks", () => ({
  useTraces: () => ({
    data: {
      data: store.traces.map((t) => ({
        ...t,
        name: "n",
        trace_start_time: 0,
        error_count: 0,
        span_count: 1,
      })),
      meta: { page: 1, limit: 50, total: store.traces.length },
    },
    isLoading: false,
    error: null,
  }),
  useSpanIO: () => ({ data: undefined, isLoading: false, error: null }),
  useTracesExist: () => ({ data: { exists: store.exists }, isPending: false, error: null }),
  usePrefetchTraces: () => vi.fn(),
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
  useParams: () => ({ projectId: store.projectId }),
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/layout/app-layout", () => ({
  useLayout: () => ({ setHideAiButton: vi.fn() }),
}));
vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));
vi.mock("@/lib/hooks/use-retention", () => ({
  useRetention: () => mockRetention(),
}));
vi.mock("@/ee/features/billing/PricingDialog", () => ({ PricingDialog: () => null }));
// The panel and the setup panel surface what the page hands them.
vi.mock("@/features/traces/components", () => ({
  TraceViewerPanel: ({
    traceId,
    source,
    onNavigate,
    onClose,
  }: {
    traceId: string;
    source?: string;
    onNavigate: (d: "up" | "down") => void;
    onClose: () => void;
  }) => (
    <div data-testid="trace-panel" data-trace-id={traceId} data-source={String(source)}>
      <button type="button" onClick={() => onNavigate("down")}>
        panel-down
      </button>
      <button type="button" onClick={onClose}>
        panel-close
      </button>
    </div>
  ),
  GettingStarted: ({ wait }: { wait: { kind: string; found?: { traceId: string } } }) => (
    <div data-testid="getting-started" data-wait={wait.kind}>
      {wait.found?.traceId}
    </div>
  ),
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
  vi.useRealTimers();
  store.projectId = "p1";
  store.exists = false;
  store.traces = [];
});

describe("the traces page of a project with no traces yet", () => {
  it("shows the setup tabs, waiting for the first trace", () => {
    render(<TracesPage />, { wrapper: Wrapper });

    expect(screen.getByTestId("getting-started").dataset.wait).toBe("waiting");
    expect(screen.queryByTestId("trace-panel")).toBeNull();
  });

  it("says the first trace arrived, then opens it", () => {
    vi.useFakeTimers();
    const { rerender } = render(<TracesPage />, { wrapper: Wrapper });

    store.exists = true;
    store.traces = [{ trace_id: "t-first" }];
    rerender(<TracesPage />);

    // The tabs stay for the moment it takes to say so.
    const panel = screen.getByTestId("getting-started");
    expect(panel.dataset.wait).toBe("found");
    expect(panel.textContent).toBe("t-first");
    expect(screen.queryByTestId("trace-panel")).toBeNull();

    act(() => vi.advanceTimersByTime(1500));

    expect(screen.getByTestId("trace-panel").getAttribute("data-trace-id")).toBe("t-first");
    expect(screen.queryByTestId("getting-started")).toBeNull();
  });

  it("waits while the arrival is known but the trace is not listed yet", () => {
    const { rerender } = render(<TracesPage />, { wrapper: Wrapper });

    store.exists = true;
    rerender(<TracesPage />);

    expect(screen.getByTestId("getting-started").dataset.wait).toBe("waiting");
    expect(screen.queryByTestId("trace-panel")).toBeNull();
  });
});

describe("the traces page of a project that already has traces", () => {
  it("opens on the list, with no trace opened for it", () => {
    vi.useFakeTimers();
    store.exists = true;
    store.traces = [{ trace_id: "t-old" }];
    render(<TracesPage />, { wrapper: Wrapper });
    act(() => vi.advanceTimersByTime(5000));

    expect(screen.queryByTestId("getting-started")).toBeNull();
    expect(screen.queryByTestId("trace-panel")).toBeNull();
  });
});

describe("moving from an empty project to one with traces", () => {
  it("does not open the other project's newest trace", () => {
    vi.useFakeTimers();
    const { rerender } = render(<TracesPage />, { wrapper: Wrapper });
    expect(screen.getByTestId("getting-started")).toBeDefined();

    store.projectId = "p2";
    store.exists = true;
    store.traces = [{ trace_id: "t-other" }];
    rerender(<TracesPage />);
    act(() => vi.advanceTimersByTime(5000));

    expect(screen.queryByTestId("getting-started")).toBeNull();
    expect(screen.queryByTestId("trace-panel")).toBeNull();
  });
});

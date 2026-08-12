// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

vi.mock("@/features/traces/hooks", () => ({
  useTraces: () => ({
    data: {
      data: [{ trace_id: "t1", name: "n", trace_start_time: 0, error_count: 0, span_count: 1 }],
      meta: { page: 1, limit: 50, total: 1 },
    },
    isLoading: false,
    error: null,
  }),
  // The page gates the onboarding empty state on a separate "has this project
  // ever traced" probe; exists: true is required so the filter bar (and the
  // user_id badge inside it) isn't suppressed by showGettingStarted.
  useTracesExist: () => ({ data: { exists: true }, isPending: false, error: null }),
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
// The page's live-view toggle and the trace list's column entry both persist through this
// hook, so the stub pins the toggle for the test and leaves the columns at their defaults.
vi.mock("@/lib/hooks/use-local-storage", () => ({
  useLocalStorage: () => [false, vi.fn()],
}));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "u1", email: "e" } }, isPending: false }),
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1" }),
  useSearchParams: () => new URLSearchParams("user_id=user-42"),
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
});

describe("TracesPage user_id filter badge", () => {
  it("shows a clearable badge for the active user_id filter", () => {
    render(<TracesPage />, { wrapper: Wrapper });

    expect(screen.getByText("User:")).toBeTruthy();
    expect(screen.getByText("user-42")).toBeTruthy();
  });
});

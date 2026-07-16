// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { ApiError } from "@/lib/api/client";

const mocks = vi.hoisted(() => ({
  sessionsError: null as unknown,
  sessionsData: undefined as unknown,
  sessionsLoading: false,
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1" }),
  useSearchParams: () => ({ get: () => null }),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/components/layout/app-layout", () => ({
  useLayout: () => ({ setHideAiButton: vi.fn() }),
}));

vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "u1" } }, isPending: false }),
}));

vi.mock("@/features/traces/hooks", () => ({
  useSessions: () => ({
    data: mocks.sessionsData,
    isLoading: mocks.sessionsLoading,
    error: mocks.sessionsError,
  }),
}));

vi.mock("@/lib/hooks/use-list-page-state", () => ({
  useListPageState: () => ({
    state: {
      dateFilter: { id: "7d" },
      customStartDate: null,
      customEndDate: null,
      keyword: "",
    },
    queryOptions: {},
    updateDateFilter: vi.fn(),
    updateCustomRange: vi.fn(),
    updateKeyword: vi.fn(),
    updateLimit: vi.fn(),
    goToPage: vi.fn(),
  }),
}));

vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));
vi.mock("@/components/search-filter-bar", () => ({ SearchFilterBar: () => null }));
vi.mock("@/components/list-pagination", () => ({ ListPagination: () => null }));
vi.mock("@/features/traces/components/SessionDetailPanel", () => ({
  SessionDetailPanel: () => null,
}));
vi.mock("@/components/RetentionGateBanner", () => ({
  RetentionGateBanner: () => <div data-testid="retention-banner" />,
}));

import SessionsPage from "./page";

afterEach(() => {
  cleanup();
  mocks.sessionsError = null;
  mocks.sessionsData = undefined;
  mocks.sessionsLoading = false;
});

describe("SessionsPage retention", () => {
  it("renders the retention banner when useSessions returns a 403 retention error", () => {
    mocks.sessionsError = new ApiError(403, {
      message: "Data outside retention window",
      retention_days: 15,
      cutoff: "2026-06-29T00:00:00",
      plan: "free",
    });
    render(<SessionsPage />);
    expect(screen.getByTestId("retention-banner")).toBeTruthy();
  });

  it("does not render the retention banner for non-retention errors", () => {
    mocks.sessionsError = new Error("network failure");
    render(<SessionsPage />);
    expect(screen.queryByTestId("retention-banner")).toBeNull();
  });
});

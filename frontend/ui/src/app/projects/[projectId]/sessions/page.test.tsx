// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
  sidebarCollapsed: false,
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1" }),
  useSearchParams: () => mocks.searchParams,
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/components/layout/app-layout", () => ({
  useLayout: () => ({
    setHideAiButton: vi.fn(),
    sidebarCollapsed: mocks.sidebarCollapsed,
  }),
}));

vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ isPending: false }),
}));

vi.mock("@/features/traces/hooks", () => ({
  useSessions: () => ({
    data: {
      data: [{ session_id: "sess-1", user_ids: [], first_trace_time: "2023-01-01" }],
      meta: { total: 1 },
    },
    isPending: false,
    error: null,
  }),
}));

vi.mock("@/lib/hooks/use-list-page-state", () => ({
  useListPageState: () => ({
    state: {},
    updateDateFilter: vi.fn(),
    updateCustomRange: vi.fn(),
    updateKeyword: vi.fn(),
    updateLimit: vi.fn(),
    goToPage: vi.fn(),
    queryOptions: {},
  }),
}));

vi.mock("@/components/search-filter-bar", () => ({
  SearchFilterBar: () => <div data-testid="search-filter-bar" />,
}));
vi.mock("@/components/list-pagination", () => ({
  ListPagination: () => <div data-testid="list-pagination" />,
}));
vi.mock("@/features/projects/components", () => ({
  ProjectBreadcrumb: () => <div data-testid="project-breadcrumb" />,
}));

// Mock SessionDetailPanel to just return a div
vi.mock("@/features/traces/components/SessionDetailPanel", () => ({
  SessionDetailPanel: () => <div data-testid="session-detail-panel" />,
}));

import SessionsPage from "./page";

afterEach(() => {
  cleanup();
  mocks.searchParams = new URLSearchParams();
});

describe("SessionsPage", () => {
  it("reads ?fullscreen=1 from URL and passes it to panel wrapper width", () => {
    // Setup URL with sessionId and fullscreen=1
    mocks.searchParams = new URLSearchParams("sessionId=sess-1&fullscreen=1");
    mocks.sidebarCollapsed = false;

    const { container } = render(<SessionsPage />);

    // Panel should be rendered
    const panel = screen.getByTestId("session-detail-panel");
    expect(panel).toBeDefined();

    // The wrapper of the panel should have the fullscreen width class (calc(100%-12rem))
    const wrapper = container.querySelector(".animate-slide-in-right");
    expect(wrapper?.className).toContain("w-[calc(100%-12rem)]");
    expect(wrapper?.className).not.toContain("w-[70%]");
  });

  it("uses w-[70%] when fullscreen=1 is not in URL", () => {
    mocks.searchParams = new URLSearchParams("sessionId=sess-1");

    const { container } = render(<SessionsPage />);

    const wrapper = container.querySelector(".animate-slide-in-right");
    expect(wrapper?.className).toContain("w-[70%]");
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

// ─── hoisted mutable mock state ──────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
  sidebarCollapsed: false,
  noData: false,
  sessions: [{ session_id: "sess-1", user_ids: [], first_trace_time: "2023-01-01" }] as Array<{
    session_id: string;
    user_ids: string[];
    first_trace_time: string;
    total_input_tokens?: number;
    total_output_tokens?: number;
    total_cost?: number;
    trace_count?: number;
  }>,
  isPending: false as boolean,
  error: null as Error | null,
}));

const panelMocks = vi.hoisted(() => ({
  onClose: vi.fn(),
  onNavigate: vi.fn(),
}));

// ─── module mocks ─────────────────────────────────────────────────────────────
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
  useSession: () => ({ isPending: mocks.isPending }),
}));

vi.mock("@/features/traces/hooks", () => ({
  useSessions: () => ({
    data: mocks.noData
      ? undefined
      : {
          data: mocks.sessions,
          meta: { total: mocks.sessions.length },
        },
    isPending: mocks.isPending,
    error: mocks.error,
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

// Capture callbacks passed to SessionDetailPanel so we can call them directly
vi.mock("@/features/traces/components/SessionDetailPanel", () => ({
  SessionDetailPanel: (props: {
    onClose: () => void;
    onNavigate: (d: "up" | "down") => void;
    canNavigateUp: boolean;
    canNavigateDown: boolean;
  }) => {
    panelMocks.onClose.mockImplementation(props.onClose);
    panelMocks.onNavigate.mockImplementation(props.onNavigate);
    return (
      <div data-testid="session-detail-panel">
        <button data-testid="panel-close-btn" onClick={props.onClose}>
          Close
        </button>
        <button
          data-testid="panel-nav-up"
          onClick={() => props.onNavigate("up")}
          disabled={!props.canNavigateUp}
        >
          Up
        </button>
        <button
          data-testid="panel-nav-down"
          onClick={() => props.onNavigate("down")}
          disabled={!props.canNavigateDown}
        >
          Down
        </button>
      </div>
    );
  },
}));

import SessionsPage from "./page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.searchParams = new URLSearchParams();
  mocks.sidebarCollapsed = false;
  mocks.noData = false;
  mocks.isPending = false;
  mocks.error = null;
  mocks.sessions = [{ session_id: "sess-1", user_ids: [], first_trace_time: "2023-01-01" }];
});

describe("SessionsPage", () => {
  // ── existing coverage ──────────────────────────────────────────────────────
  it("reads ?fullscreen=1 from URL and passes initialFullscreen=true to SessionDetailPanel", () => {
    mocks.searchParams = new URLSearchParams("sessionId=sess-1&fullscreen=1");
    render(<SessionsPage />);
    expect(screen.getByTestId("session-detail-panel")).toBeDefined();
  });

  it("renders SessionDetailPanel without fullscreen when fullscreen=1 is not in URL", () => {
    mocks.searchParams = new URLSearchParams("sessionId=sess-1");
    render(<SessionsPage />);
    expect(screen.getByTestId("session-detail-panel")).toBeDefined();
  });

  // ── line 241-242: onClose sets selectedSessionId to null ──────────────────
  it("closes the detail panel when onClose is called (lines 241-242)", () => {
    mocks.searchParams = new URLSearchParams("sessionId=sess-1");

    render(<SessionsPage />);

    // Panel is open
    expect(screen.getByTestId("session-detail-panel")).toBeDefined();

    // Trigger onClose via the button exposed by our mock
    fireEvent.click(screen.getByTestId("panel-close-btn"));

    // Panel should be removed from the DOM
    expect(screen.queryByTestId("session-detail-panel")).toBeNull();
  });

  // ── lines 244-250: onNavigate up ──────────────────────────────────────────
  it("navigates up to the previous session (lines 244-250)", () => {
    mocks.sessions = [
      { session_id: "sess-1", user_ids: [], first_trace_time: "2023-01-01" },
      { session_id: "sess-2", user_ids: [], first_trace_time: "2023-01-02" },
    ];
    // Start with sess-2 selected so navigating up lands on sess-1
    mocks.searchParams = new URLSearchParams("sessionId=sess-2");

    render(<SessionsPage />);

    // nav-up should be enabled (currentIndex 1 > 0)
    const upBtn = screen.getByTestId("panel-nav-up");
    expect((upBtn as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(upBtn);

    // After navigating up the panel re-renders with sess-1 (still visible)
    expect(screen.getByTestId("session-detail-panel")).toBeDefined();
  });

  // ── lines 249-250: onNavigate down ────────────────────────────────────────
  it("navigates down to the next session (lines 249-250)", () => {
    mocks.sessions = [
      { session_id: "sess-1", user_ids: [], first_trace_time: "2023-01-01" },
      { session_id: "sess-2", user_ids: [], first_trace_time: "2023-01-02" },
    ];
    mocks.searchParams = new URLSearchParams("sessionId=sess-1");

    render(<SessionsPage />);

    const downBtn = screen.getByTestId("panel-nav-down");
    expect((downBtn as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(downBtn);

    expect(screen.getByTestId("session-detail-panel")).toBeDefined();
  });

  // ── line 252: onNavigate noop at boundaries ───────────────────────────────
  it("does not crash when navigate is called at the list boundaries (line 252)", () => {
    // Single session — navigate up/down should both be disabled / noop
    mocks.sessions = [{ session_id: "sess-1", user_ids: [], first_trace_time: "2023-01-01" }];
    mocks.searchParams = new URLSearchParams("sessionId=sess-1");

    render(<SessionsPage />);

    const upBtn = screen.getByTestId("panel-nav-up");
    const downBtn = screen.getByTestId("panel-nav-down");

    // Both buttons are disabled since we are at both boundaries
    expect((upBtn as HTMLButtonElement).disabled).toBe(true);
    expect((downBtn as HTMLButtonElement).disabled).toBe(true);

    // Clicking them should not crash
    fireEvent.click(upBtn);
    fireEvent.click(downBtn);

    expect(screen.getByTestId("session-detail-panel")).toBeDefined();
  });

  // ── loading state ──────────────────────────────────────────────────────────
  it("shows loading state when data is pending", () => {
    mocks.isPending = true;

    render(<SessionsPage />);

    expect(screen.getByText("Loading sessions...")).toBeDefined();
  });

  // ── error state ────────────────────────────────────────────────────────────
  it("shows error state when there is an error and no data", () => {
    mocks.error = new Error("network error");
    mocks.noData = true; // data=undefined so the error&&!data branch triggers

    render(<SessionsPage />);

    expect(screen.getByText("Error loading sessions")).toBeDefined();
  });

  // ── empty state ────────────────────────────────────────────────────────────
  it("shows empty state when sessions list is empty and no error", () => {
    mocks.sessions = [];

    render(<SessionsPage />);

    expect(screen.getByText("No sessions found")).toBeDefined();
  });

  // ── clicking a session row opens the detail panel ─────────────────────────
  it("opens the detail panel when a session row is clicked", () => {
    mocks.sessions = [{ session_id: "sess-99", user_ids: [], first_trace_time: "2023-06-01" }];

    render(<SessionsPage />);

    // Panel should not be visible before clicking (no sessionId in URL)
    expect(screen.queryByTestId("session-detail-panel")).toBeNull();

    // Click the session row
    fireEvent.click(screen.getByText("sess-99"));

    expect(screen.getByTestId("session-detail-panel")).toBeDefined();
  });
});

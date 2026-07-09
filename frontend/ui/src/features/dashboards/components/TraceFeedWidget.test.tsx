// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TraceListItem } from "@/types/api";
import type { TimeRange } from "../types";
import { TraceFeedWidget } from "./TraceFeedWidget";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

// Mutable so individual tests can put the session into its resolving state.
const auth = {
  data: { user: { id: "u1", email: "u@example.com" } } as {
    user: { id: string; email: string };
  } | null,
  isPending: false,
};
vi.mock("@/lib/auth-client", () => ({
  useSession: () => auth,
}));

vi.mock("@/lib/api/traces", () => ({
  getTraces: vi.fn(),
}));

import { getTraces } from "@/lib/api/traces";

afterEach(() => {
  cleanup();
  vi.mocked(getTraces).mockReset();
  auth.data = { user: { id: "u1", email: "u@example.com" } };
  auth.isPending = false;
});

const RANGE: TimeRange = {
  start: new Date("2026-06-01T00:00:00Z"),
  end: new Date("2026-06-02T00:00:00Z"),
};

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function renderWidget(spec: { limit?: number } = {}) {
  return render(<TraceFeedWidget projectId="p1" spec={spec} range={RANGE} />, { wrapper });
}

function makeTrace(overrides: Partial<TraceListItem> = {}): TraceListItem {
  return {
    trace_id: "t1",
    project_id: "p1",
    name: "checkout-flow",
    trace_start_time: "2026-06-01T12:00:00Z",
    user_id: null,
    session_id: null,
    span_count: 3,
    duration_ms: 1500,
    error_count: 0,
    input: null,
    output: null,
    total_cost: 0.1234,
    ...overrides,
  };
}

describe("TraceFeedWidget", () => {
  it("shows a loading state while the query is pending", () => {
    vi.mocked(getTraces).mockReturnValue(new Promise(() => {}));
    renderWidget();
    expect(screen.getByText("Loading…")).toBeTruthy();
  });

  it("stays loading while the auth session resolves, not the empty state", () => {
    auth.data = null;
    auth.isPending = true;
    renderWidget();
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(screen.queryByText("No traces in this time range")).toBeNull();
    expect(getTraces).not.toHaveBeenCalled();
  });

  it("shows an error state when the query fails", async () => {
    vi.mocked(getTraces).mockRejectedValue(new Error("boom"));
    renderWidget();
    await waitFor(() => expect(screen.getByText("Failed to load traces")).toBeTruthy());
  });

  it("shows an empty state when there are no traces", async () => {
    vi.mocked(getTraces).mockResolvedValue({
      data: [],
      meta: { page: 0, limit: 10, total: 0 },
    });
    renderWidget();
    await waitFor(() => expect(screen.getByText("No traces in this time range")).toBeTruthy());
  });

  it("renders a populated list with status chips, cost, time and links", async () => {
    vi.mocked(getTraces).mockResolvedValue({
      data: [
        makeTrace({ trace_id: "err-trace", name: "errored-run", error_count: 2, total_cost: 0.5 }),
        makeTrace({ trace_id: "ok-trace", name: "clean-run", error_count: 0, total_cost: 0 }),
        makeTrace({
          trace_id: "null-cost-trace",
          name: "no-cost-run",
          error_count: 0,
          total_cost: undefined,
        }),
      ],
      meta: { page: 0, limit: 10, total: 3 },
    });
    renderWidget();

    await waitFor(() => expect(screen.getByText("errored-run")).toBeTruthy());

    expect(screen.getByText("ERROR")).toBeTruthy();
    expect(screen.getAllByText("OK")).toHaveLength(2);

    expect(screen.getByText("$0.5000")).toBeTruthy();
    expect(screen.getAllByText("—")).toHaveLength(2);

    const nameLink = screen.getByText("errored-run").closest("a");
    expect(nameLink?.getAttribute("href")).toBe("/projects/p1/traces?traceId=err-trace");

    const expectedTime = new Date("2026-06-01T12:00:00Z").toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const timeLinks = screen.getAllByText(expectedTime);
    expect(timeLinks.length).toBeGreaterThan(0);
    expect(timeLinks[0].closest("a")?.getAttribute("href")).toBe(
      "/projects/p1/traces?traceId=err-trace",
    );
  });

  it("passes spec.limit and the range bounds to getTraces", async () => {
    vi.mocked(getTraces).mockResolvedValue({
      data: [makeTrace()],
      meta: { page: 0, limit: 25, total: 1 },
    });
    renderWidget({ limit: 25 });

    await waitFor(() => expect(getTraces).toHaveBeenCalled());
    expect(getTraces).toHaveBeenCalledWith(
      "p1",
      "",
      {
        page: 0,
        limit: 25,
        start_after: RANGE.start.toISOString(),
        end_before: RANGE.end.toISOString(),
      },
      { id: "u1", email: "u@example.com" },
    );
  });

  it("defaults the limit to 10 when spec.limit is not provided", async () => {
    vi.mocked(getTraces).mockResolvedValue({
      data: [makeTrace()],
      meta: { page: 0, limit: 10, total: 1 },
    });
    renderWidget();

    await waitFor(() => expect(getTraces).toHaveBeenCalled());
    expect(getTraces).toHaveBeenCalledWith(
      "p1",
      "",
      expect.objectContaining({ limit: 10 }),
      expect.anything(),
    );
  });
});

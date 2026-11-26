// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent, within } from "@testing-library/react";
import type { Loop } from "@/features/loops/hooks/use-loops";
import type { LoopRunDto } from "@traceroot/core/loops/pure";

const mocks = vi.hoisted(() => ({
  loop: { data: undefined as unknown, isLoading: false, error: null as Error | null },
  runs: { data: undefined as unknown, isLoading: false, error: null as Error | null },
  workspace: { data: undefined as unknown },
  search: new URLSearchParams(),
  runById: { data: undefined as unknown, error: null as Error | null },
  useLoopRun: vi.fn(),
  useLoopRuns: vi.fn(),
  setStatus: vi.fn(),
  runNow: vi.fn(),
  deleteLoop: vi.fn(),
  push: vi.fn(),
  goToPage: vi.fn(),
  updateLimit: vi.fn(),
  layout: { openAiSession: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1", loopId: "loop-1" }),
  useSearchParams: () => mocks.search,
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock("@/lib/hooks/use-list-page-state", () => ({
  useListPageState: () => ({
    state: { page: 0, limit: 50 },
    goToPage: mocks.goToPage,
    updateLimit: mocks.updateLimit,
  }),
}));
vi.mock("@/lib/hooks/use-list-return", () => ({
  useListReturnHref: (_key: string, path: string) => `${path}?page_index=2`,
}));
vi.mock("@/components/layout/app-layout", () => ({ useLayout: () => mocks.layout }));
vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));
vi.mock("@/features/projects/hooks", () => ({
  useProject: () => ({ data: { workspace_id: "ws-1" } }),
}));
vi.mock("@/features/workspaces/hooks", () => ({ useWorkspace: () => mocks.workspace }));
vi.mock("@/features/loops/hooks/use-loops", async (importActual) => ({
  isActiveRun: (await importActual<typeof import("@/features/loops/hooks/use-loops")>())
    .isActiveRun,
  useLoop: () => mocks.loop,
  useLoopRuns: (...args: unknown[]) => {
    mocks.useLoopRuns(...args);
    return mocks.runs;
  },
  useLoopRun: (...args: unknown[]) => {
    mocks.useLoopRun(...args);
    return mocks.runById;
  },
  useSetLoopStatus: () => ({ mutate: mocks.setStatus, isPending: false, error: null }),
  useRunLoop: () => ({ mutate: mocks.runNow, isPending: false, isError: false, error: null }),
  useDeleteLoop: () => ({
    mutate: mocks.deleteLoop,
    reset: () => {},
    isPending: false,
    error: null,
  }),
}));

import LoopDetailPage from "./page";

const loop = (over: Partial<Loop> = {}): Loop =>
  ({
    id: "loop-1",
    detectorId: "det-1",
    name: "Coding agents",
    status: "active",
    failureStreak: 0,
    dryRun: false,
    model: null,
    provider: null,
    source: null,
    schedule: { kind: "daily", hour: 9, timezone: "Europe/Berlin" },
    nextRunAt: "2026-11-12T08:00:00Z",
    lastRunAt: "2026-11-11T09:00:00Z",
    runCount: 5,
    avgCostUsd: 0.3332,
    signalCount: 3,
    ...over,
  }) as Loop;

const run = (over: Partial<LoopRunDto> = {}): LoopRunDto =>
  ({
    id: "r1",
    seq: 1,
    status: "succeeded",
    trigger: "schedule",
    findingKeys: [],
    summary: null,
    error: null,
    sessionId: null,
    startedAt: "2026-11-11T09:00:00Z",
    finishedAt: "2026-11-11T09:05:00Z",
    createTime: "2026-11-11T09:00:00Z",
    tracesRead: 0,
    costUsd: null,
    ...over,
  }) as LoopRunDto;

const withRuns = (runs: LoopRunDto[]) => {
  mocks.runs = {
    data: { data: runs, meta: { page: 0, limit: 50, total: runs.length } },
    isLoading: false,
    error: null,
  };
};

beforeEach(() => {
  // Fix the clock three hours before the fixture's next run, so relative times are stable.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-12T05:00:00Z"));
  mocks.loop = { data: loop(), isLoading: false, error: null };
  withRuns([run()]);
  mocks.workspace = { data: { loopBlocked: false, currentUsage: { loop: { runsUsed: 5 } } } };
  mocks.search = new URLSearchParams();
  mocks.runById = { data: undefined, error: null };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("Loop detail", () => {
  it("is the detector page's shape: header, one runs table, then the list pagination", () => {
    render(<LoopDetailPage />);
    expect(screen.getByRole("heading", { name: "Coding agents" })).toBeTruthy();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByText("Signals found")).toBeNull();
    const table = screen.getByRole("table");
    const next = screen.getByRole("button", { name: "Next page" });
    expect(table.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("has one primary Run now and the rest in the actions menu", () => {
    render(<LoopDetailPage />);
    expect(screen.getByRole("button", { name: "Run now" }).querySelector("svg")).toBeNull();
    expect(screen.queryByRole("link", { name: /Edit/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Actions for Coding agents" }));
    expect(screen.getByRole("link", { name: /Edit/ }).getAttribute("href")).toBe(
      "/projects/proj-1/loops/loop-1/edit?from=detail",
    );
    const signals = new URL(
      screen.getByRole("link", { name: /View signals/ }).getAttribute("href")!,
      "http://x",
    );
    expect(signals.pathname).toBe("/projects/proj-1/signals");
    expect(signals.searchParams.get("filters")).toContain("Coding agents");
    expect(screen.getByRole("button", { name: /Delete/ })).toBeTruthy();
  });

  it("goes back to the list it came from", () => {
    render(<LoopDetailPage />);
    expect(screen.getByRole("link", { name: /Loops/ }).getAttribute("href")).toBe(
      "/projects/proj-1/loops?page_index=2",
    );
  });

  it("deletes the loop from the menu once its name is typed, then returns to the list", () => {
    mocks.deleteLoop.mockImplementation((_id: string, opts: { onSuccess: () => void }) =>
      opts.onSuccess(),
    );
    render(<LoopDetailPage />);
    fireEvent.click(screen.getByRole("button", { name: "Actions for Coding agents" }));
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    const dialog = screen.getByRole("dialog", { name: "Delete loop" });
    fireEvent.change(within(dialog).getByPlaceholderText("Coding agents"), {
      target: { value: "Coding agents" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(mocks.deleteLoop).toHaveBeenCalledWith("loop-1", expect.any(Object));
    expect(mocks.push).toHaveBeenCalledWith("/projects/proj-1/loops?page_index=2");
  });

  it("explains a system pause and offers Resume", () => {
    mocks.loop = {
      data: loop({
        status: "paused_by_system",
        failureStreak: 5,
        nextRunAt: null,
      }),
      isLoading: false,
      error: null,
    };
    render(<LoopDetailPage />);
    const notice = screen.getByText(/Paused automatically after 5 scheduled runs in a row failed/);
    expect(notice.parentElement!.className).toContain("bg-warning-soft");
    expect(screen.getAllByText(/paused/i)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Actions for Coding agents" }));
    fireEvent.click(screen.getByRole("button", { name: /Resume/ }));
    expect(mocks.setStatus).toHaveBeenCalledWith({ loopId: "loop-1", action: "resume" });
  });

  it("pauses an active loop", () => {
    render(<LoopDetailPage />);
    fireEvent.click(screen.getByRole("button", { name: "Actions for Coding agents" }));
    fireEvent.click(screen.getByRole("button", { name: /Pause/ }));
    expect(mocks.setStatus).toHaveBeenCalledWith({ loopId: "loop-1", action: "pause" });
  });

  it("says when the Free plan's loop runs are used up, with a link to billing", () => {
    mocks.workspace = {
      data: { loopBlocked: true, billingPlan: "free", currentUsage: { loop: { runsUsed: 30 } } },
    };
    render(<LoopDetailPage />);
    expect(screen.getByText(/30 loop runs are used/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "upgrade" }).getAttribute("href")).toBe(
      "/workspaces/ws-1/settings/billing",
    );
  });

  it("lets a paid workspace run with the flag still set, and says nothing about a limit", () => {
    mocks.workspace = {
      data: { loopBlocked: true, billingPlan: "pro", currentUsage: { loop: { runsUsed: 30 } } },
    };
    render(<LoopDetailPage />);
    expect(screen.queryByText(/loop runs are used/)).toBeNull();
    const button = screen.getByRole("button", { name: "Run now" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(mocks.runNow).toHaveBeenCalledTimes(1);
  });

  it("says nothing about a limit while runs remain", () => {
    render(<LoopDetailPage />);
    expect(screen.queryByText(/loop runs are used/)).toBeNull();
  });

  it("notes a dry-run loop once, in the same notice bar as the pause and plan limit", () => {
    mocks.loop = {
      data: loop({ dryRun: true, status: "paused", nextRunAt: null }),
      isLoading: false,
      error: null,
    };
    mocks.workspace = {
      data: { loopBlocked: true, billingPlan: "free", currentUsage: { loop: { runsUsed: 30 } } },
    };
    render(<LoopDetailPage />);
    const dry = screen.getByText(/Dry run: this loop records a summary/);
    expect(screen.getAllByText(/Dry run/)).toHaveLength(1);
    const bar = dry.parentElement!;
    expect(within(bar).getByText(/^Paused\./)).toBeTruthy();
    expect(within(bar).getByText(/loop runs are used/)).toBeTruthy();
  });

  it("Run now queues a run, and is replaced by a disabled Run queued while one is active", () => {
    const { unmount } = render(<LoopDetailPage />);
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    expect(mocks.runNow).toHaveBeenCalledTimes(1);
    expect(mocks.useLoopRuns).toHaveBeenLastCalledWith("proj-1", "loop-1", {
      page: 0,
      limit: 50,
      poll: false,
    });
    unmount();
    const queued = run({ id: "r2", seq: 2, status: "pending", startedAt: null, finishedAt: null });
    mocks.loop = { data: loop({ lastRun: queued }), isLoading: false, error: null };
    withRuns([queued, run()]);
    render(<LoopDetailPage />);
    expect((screen.getByRole("button", { name: "Run queued" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText("Queued")).toBeTruthy();
    // Polling stays silent.
    expect(screen.queryByText(/looks again/)).toBeNull();
  });

  it("says Running once the worker has started the run", () => {
    const started = run({ id: "r2", seq: 2, status: "running", finishedAt: null });
    mocks.loop = { data: loop({ lastRun: started }), isLoading: false, error: null };
    withRuns([started, run()]);
    render(<LoopDetailPage />);
    expect((screen.getByRole("button", { name: "Running…" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.queryByRole("button", { name: "Run queued" })).toBeNull();
  });

  it("knows about a run queued on an earlier page, and keeps the runs polling", () => {
    const queued = run({
      id: "r60",
      seq: 60,
      status: "pending",
      startedAt: null,
      finishedAt: null,
    });
    mocks.loop = { data: loop({ lastRun: queued }), isLoading: false, error: null };
    withRuns([run({ id: "r10", seq: 10 })]);
    render(<LoopDetailPage />);
    expect((screen.getByRole("button", { name: "Run queued" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(mocks.useLoopRuns).toHaveBeenLastCalledWith(
      "proj-1",
      "loop-1",
      expect.objectContaining({ poll: true }),
    );
  });

  it("disables Run now, and says why, when the plan's loop runs are used up", () => {
    mocks.workspace = {
      data: { loopBlocked: true, billingPlan: "free", currentUsage: { loop: { runsUsed: 30 } } },
    };
    render(<LoopDetailPage />);
    const button = screen.getByRole("button", { name: "Run now" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.parentElement?.title).toMatch(/used its plan's loop runs/);
    fireEvent.click(button);
    expect(mocks.runNow).not.toHaveBeenCalled();
  });

  it("disables Run now on a paused loop, and says to resume it", () => {
    for (const status of ["paused", "paused_by_system"] as const) {
      mocks.loop = {
        data: loop({ status, nextRunAt: null }),
        isLoading: false,
        error: null,
      };
      const { unmount } = render(<LoopDetailPage />);
      const button = screen.getByRole("button", { name: "Run now" }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.parentElement?.title).toBe("Resume this loop to run it.");
      unmount();
    }
  });

  it("puts only Run now and the actions menu beside the name in the header", () => {
    render(<LoopDetailPage />);
    const heading = screen.getByRole("heading", { name: "Coding agents" });
    // No status badge in the header: Run now and the menu are the only actions.
    const actions = heading.nextElementSibling as HTMLElement;
    expect(
      within(actions)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label") ?? b.textContent),
    ).toEqual(["Run now", "Actions for Coding agents"]);
  });

  it("opens a run's transcript in the assistant rail", () => {
    withRuns([run({ sessionId: "sess-1", seq: 4 })]);
    render(<LoopDetailPage />);
    fireEvent.click(screen.getByRole("button", { name: "sess-1" }));
    expect(mocks.layout.openAiSession).toHaveBeenCalledWith("sess-1");
  });

  describe("a ?run= link from a signal", () => {
    it("opens the linked run's transcript once, and marks its row", () => {
      mocks.search = new URLSearchParams("run=r7");
      withRuns([run({ id: "r8", seq: 8 }), run({ id: "r7", seq: 7, sessionId: "sess-7" })]);
      const { rerender } = render(<LoopDetailPage />);
      expect(mocks.layout.openAiSession).toHaveBeenCalledWith("sess-7");
      // On the loaded page: no fetch by id.
      expect(mocks.useLoopRun).toHaveBeenLastCalledWith("proj-1", "loop-1", null);
      expect(screen.getByText("#7").closest("tr")!.getAttribute("aria-current")).toBe("true");
      expect(screen.getByText("sess-7").tagName).toBe("BUTTON");
      // A refetch brings the same run as a new object: the rail is not opened again.
      withRuns([run({ id: "r8", seq: 8 }), run({ id: "r7", seq: 7, sessionId: "sess-7" })]);
      rerender(<LoopDetailPage />);
      expect(mocks.layout.openAiSession).toHaveBeenCalledTimes(1);
    });

    it("fetches a run that is not on the loaded page by id, then opens it", () => {
      mocks.search = new URLSearchParams("run=r2");
      withRuns([run({ id: "r60", seq: 60 })]);
      mocks.runById = { data: run({ id: "r2", seq: 2, sessionId: "sess-2" }), error: null };
      render(<LoopDetailPage />);
      expect(mocks.useLoopRun).toHaveBeenCalledWith("proj-1", "loop-1", "r2");
      expect(mocks.layout.openAiSession).toHaveBeenCalledWith("sess-2");
    });

    it("says when the linked run has no transcript yet, and opens nothing", () => {
      mocks.search = new URLSearchParams("run=r9");
      withRuns([run({ id: "r9", seq: 9, status: "running", finishedAt: null })]);
      render(<LoopDetailPage />);
      expect(screen.getByText("Run #9 has no transcript yet.").parentElement!.className).toContain(
        "bg-warning-soft",
      );
      expect(mocks.layout.openAiSession).not.toHaveBeenCalled();
    });

    it("says when the linked run is not found", () => {
      mocks.search = new URLSearchParams("run=gone");
      mocks.runById = { data: undefined, error: new Error("Run not found") };
      render(<LoopDetailPage />);
      expect(screen.getByText("The linked run was not found.")).toBeTruthy();
      expect(mocks.layout.openAiSession).not.toHaveBeenCalled();
    });

    it("fetches nothing without a link", () => {
      render(<LoopDetailPage />);
      expect(mocks.useLoopRun).toHaveBeenLastCalledWith("proj-1", "loop-1", null);
      expect(screen.queryByText(/no transcript yet/)).toBeNull();
    });
  });

  it("explains a loop with no runs yet, with the time of the first scheduled run", () => {
    withRuns([]);
    render(<LoopDetailPage />);
    expect(screen.getByText("No runs yet")).toBeTruthy();
    expect(screen.getByText(/The first scheduled run is Thu 12 Nov, 09:00 CET/)).toBeTruthy();
  });

  it("says no run is scheduled while the loop is paused", () => {
    mocks.loop = {
      data: loop({ status: "paused", nextRunAt: null }),
      isLoading: false,
      error: null,
    };
    withRuns([]);
    render(<LoopDetailPage />);
    expect(screen.getByText(/No run is scheduled while the loop is paused/)).toBeTruthy();
    expect(screen.getByText(/Resume it to run it again/)).toBeTruthy();
    expect(screen.queryByText(/Use Run now/)).toBeNull();
  });

  it("waits while loading and reports a missing loop", () => {
    mocks.loop = { data: undefined, isLoading: true, error: null };
    const { unmount } = render(<LoopDetailPage />);
    expect(screen.getByText("Loading loop...")).toBeTruthy();
    unmount();
    mocks.loop = { data: undefined, isLoading: false, error: new Error("Loop not found") };
    render(<LoopDetailPage />);
    expect(screen.getByText("Loop not found")).toBeTruthy();
  });
});

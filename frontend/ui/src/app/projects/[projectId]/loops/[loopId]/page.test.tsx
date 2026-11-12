// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import type { Loop } from "@/features/loops/hooks/use-loops";
import type { LoopRunDto } from "@traceroot/core/loops/pure";

const mocks = vi.hoisted(() => ({
  loop: { data: undefined as unknown, isLoading: false, error: null as Error | null },
  runs: { data: undefined as unknown, isLoading: false, error: null as Error | null },
  findings: { data: undefined as unknown, isLoading: false },
  memory: { data: undefined as unknown, isLoading: false },
  planLimit: { data: undefined as unknown },
  setStatus: vi.fn(),
  runNow: vi.fn(),
  layout: {
    setAiContext: vi.fn(),
    setAiInitialSessionId: vi.fn(),
    setAiPanelOpen: vi.fn(),
  },
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1", loopId: "loop-1" }),
}));
vi.mock("@/components/layout/app-layout", () => ({ useLayout: () => mocks.layout }));
vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));
vi.mock("@/features/projects/hooks", () => ({
  useProject: () => ({ data: { workspace_id: "ws-1" } }),
}));
vi.mock("@/features/loops/hooks/use-loops", () => ({
  ACTIVE_RUN_POLL_MS: 10_000,
  useLoop: () => mocks.loop,
  useLoopRuns: () => mocks.runs,
  useLoopFindings: () => mocks.findings,
  useLoopMemory: () => mocks.memory,
  useLoopPlanLimit: () => mocks.planLimit,
  useSetLoopStatus: () => ({ mutate: mocks.setStatus, isPending: false, error: null }),
  useRunLoop: () => ({ mutate: mocks.runNow, isPending: false, isError: false, error: null }),
}));

import LoopDetailPage from "./page";

const loop = (over: Partial<Loop> = {}): Loop =>
  ({
    id: "loop-1",
    detectorId: "det-1",
    name: "Coding agents",
    status: "active",
    pauseReason: null,
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
  mocks.loop = { data: loop(), isLoading: false, error: null };
  withRuns([run()]);
  mocks.findings = { data: { data: [], meta: { page: 0, limit: 50, total: 0 } }, isLoading: false };
  mocks.memory = { data: [], isLoading: false };
  mocks.planLimit = { data: { blocked: false, runsUsed: 5, included: 30, plan: "free" } };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Loop detail", () => {
  it("shows the Loop's schedule, next run in its zone, model, last run, usage and signals", () => {
    render(<LoopDetailPage />);
    expect(screen.getByRole("heading", { name: "Coding agents" })).toBeTruthy();
    expect(screen.getByText("Daily at 09:00 Europe/Berlin")).toBeTruthy();
    expect(screen.getByText("Thu 12 Nov, 09:00 CET")).toBeTruthy();
    expect(screen.getByText("Project Agent model")).toBeTruthy();
    expect(screen.getByText("Signals found").nextSibling?.textContent).toBe("3");
  });

  it("names a BYOK model with its provider and the Loop's own model otherwise", () => {
    mocks.loop = {
      data: loop({ model: "gpt-5.4", provider: "My OpenAI", source: "byok" }),
      isLoading: false,
      error: null,
    };
    render(<LoopDetailPage />);
    expect(screen.getByText("gpt-5.4 (BYOK, My OpenAI)")).toBeTruthy();
  });

  it("counts each tab", () => {
    mocks.findings = {
      data: { data: [], meta: { page: 0, limit: 50, total: 2 } },
      isLoading: false,
    };
    mocks.memory = { data: [{ id: "m" }, { id: "n" }, { id: "o" }], isLoading: false };
    render(<LoopDetailPage />);
    expect(screen.getByRole("tab", { name: /Runs\s*1/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Findings\s*2/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Memory\s*3/ })).toBeTruthy();
  });

  it("switches to the findings and memory tabs", () => {
    mocks.findings = {
      data: {
        data: [
          {
            signalId: "s1",
            title: "A finding",
            status: "open",
            criteriaCovers: "c",
            hitCount: 1,
            firstSeenAt: "2026-11-11T00:00:00Z",
            lastSeenAt: "2026-11-11T00:00:00Z",
            groupKey: null,
          },
        ],
        meta: { page: 0, limit: 50, total: 1 },
      },
      isLoading: false,
    };
    mocks.memory = {
      data: [
        {
          id: "m",
          loopId: null,
          key: "repo-conventions",
          content: "x",
          expiresAt: null,
          expired: false,
          updatedByRunId: null,
          updateTime: "2026-11-11T00:00:00Z",
        },
      ],
      isLoading: false,
    };
    render(<LoopDetailPage />);
    fireEvent.click(screen.getByRole("tab", { name: /Findings/ }));
    expect(screen.getByRole("link", { name: "A finding" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Memory/ }));
    expect(screen.getByText("repo-conventions")).toBeTruthy();
  });

  it("explains a system pause and offers Resume", () => {
    mocks.loop = {
      data: loop({
        status: "paused_by_system",
        pauseReason: "failures",
        failureStreak: 5,
        nextRunAt: null,
      }),
      isLoading: false,
      error: null,
    };
    render(<LoopDetailPage />);
    expect(
      screen.getByText(/Paused automatically after 5 scheduled runs in a row failed/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Resume/ }));
    expect(mocks.setStatus).toHaveBeenCalledWith({ loopId: "loop-1", action: "resume" });
  });

  it("pauses an active Loop", () => {
    render(<LoopDetailPage />);
    fireEvent.click(screen.getByRole("button", { name: /Pause/ }));
    expect(mocks.setStatus).toHaveBeenCalledWith({ loopId: "loop-1", action: "pause" });
  });

  it("says when the Free plan's Loop runs are used up, with a link to billing", () => {
    mocks.planLimit = { data: { blocked: true, runsUsed: 30, included: 30, plan: "free" } };
    render(<LoopDetailPage />);
    expect(screen.getByText(/30 Loop runs are used/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "upgrade" }).getAttribute("href")).toBe(
      "/workspaces/ws-1/settings/billing",
    );
  });

  it("says nothing about a limit while runs remain", () => {
    render(<LoopDetailPage />);
    expect(screen.queryByText(/Loop runs are used/)).toBeNull();
  });

  it("notes a dry-run Loop", () => {
    mocks.loop = { data: loop({ dryRun: true }), isLoading: false, error: null };
    render(<LoopDetailPage />);
    expect(screen.getByText(/Dry run: this Loop records a summary/)).toBeTruthy();
  });

  it("Run now queues a run, and is replaced by a disabled Run queued while one is active", () => {
    const { unmount } = render(<LoopDetailPage />);
    fireEvent.click(screen.getByRole("button", { name: "Run now" }));
    expect(mocks.runNow).toHaveBeenCalledTimes(1);
    unmount();
    withRuns([
      run({ id: "r2", seq: 2, status: "pending", startedAt: null, finishedAt: null }),
      run(),
    ]);
    render(<LoopDetailPage />);
    expect((screen.getByRole("button", { name: "Run queued" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText("Queued")).toBeTruthy();
    expect(screen.getByText(/looks again every 10 s/)).toBeTruthy();
  });

  it("opens a run's transcript in the assistant rail, and closes it when the page goes", () => {
    withRuns([run({ sessionId: "sess-1", seq: 4 })]);
    const { unmount } = render(<LoopDetailPage />);
    fireEvent.click(screen.getByRole("button", { name: "Open the transcript of run 4" }));
    expect(mocks.layout.setAiContext).toHaveBeenCalledWith(null);
    expect(mocks.layout.setAiInitialSessionId).toHaveBeenCalledWith("sess-1");
    expect(mocks.layout.setAiPanelOpen).toHaveBeenCalledWith(true);
    unmount();
    expect(mocks.layout.setAiPanelOpen).toHaveBeenLastCalledWith(false);
    expect(mocks.layout.setAiInitialSessionId).toHaveBeenLastCalledWith(undefined);
  });

  it("explains a Loop with no runs yet, with the time of the first scheduled run", () => {
    withRuns([]);
    render(<LoopDetailPage />);
    expect(screen.getByText("No runs yet")).toBeTruthy();
    expect(screen.getByText(/The first scheduled run is Thu 12 Nov, 09:00 CET/)).toBeTruthy();
  });

  it("says no run is scheduled while the Loop is paused", () => {
    mocks.loop = {
      data: loop({ status: "paused", nextRunAt: null }),
      isLoading: false,
      error: null,
    };
    withRuns([]);
    render(<LoopDetailPage />);
    expect(screen.getByText(/No run is scheduled while the Loop is paused/)).toBeTruthy();
  });

  it("waits while loading and reports a missing Loop", () => {
    mocks.loop = { data: undefined, isLoading: true, error: null };
    const { unmount } = render(<LoopDetailPage />);
    expect(screen.getByText("Loading Loop...")).toBeTruthy();
    unmount();
    mocks.loop = { data: undefined, isLoading: false, error: new Error("Loop not found") };
    render(<LoopDetailPage />);
    expect(screen.getByText("Loop not found")).toBeTruthy();
  });
});

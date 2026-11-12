// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent, within } from "@testing-library/react";
import type { Loop } from "@/features/loops/hooks/use-loops";
import type { LoopRunDto } from "@traceroot/core/loops/pure";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  list: { data: undefined as unknown, isLoading: false, error: null as Error | null },
  keyword: "",
  updateKeyword: vi.fn(),
  setStatus: vi.fn(),
  deleteLoop: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "proj-1" }),
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));
vi.mock("@/lib/hooks/use-list-return", () => ({ useRememberListQuery: () => {} }));
vi.mock("@/lib/hooks/use-scroll-to-top-on-change", () => ({ useScrollToTopOnChange: () => {} }));
vi.mock("@/lib/hooks/use-list-page-state", () => ({
  useListPageState: () => ({
    state: { page: 0, limit: 50, keyword: mocks.keyword },
    queryOptions: { page: 0, limit: 50, search_query: mocks.keyword || undefined },
    updateKeyword: mocks.updateKeyword,
    updateLimit: () => {},
    goToPage: () => {},
  }),
}));
vi.mock("@/features/loops/hooks/use-loops", () => ({
  useLoopList: () => mocks.list,
  useSetLoopStatus: () => ({ mutate: mocks.setStatus, isPending: false, error: null }),
  useDeleteLoop: () => ({ mutate: mocks.deleteLoop, isPending: false, error: null }),
}));

import LoopsPage from "./page";

const run = (status: string, over: Record<string, unknown> = {}): LoopRunDto =>
  ({
    id: `r-${status}`,
    status,
    findingKeys: [],
    startedAt: "2026-11-11T09:00:00Z",
    createTime: "2026-11-11T09:00:00Z",
    error: null,
    summary: null,
    ...over,
  }) as unknown as LoopRunDto;

const loop = (over: Partial<Loop> = {}): Loop =>
  ({
    id: "l1",
    detectorId: "d1",
    name: "Coding agents",
    status: "active",
    pauseReason: null,
    failureStreak: 0,
    dryRun: false,
    schedule: { kind: "daily", hour: 9, timezone: "Europe/Berlin" },
    nextRunAt: "2026-11-12T08:00:00Z",
    lastRun: run("succeeded", { findingKeys: ["a", "b"] }),
    runCount: 5,
    avgCostUsd: 0.3332,
    signalCount: 3,
    ...over,
  }) as Loop;

const withLoops = (loops: Loop[], total = loops.length) => {
  mocks.list = {
    data: { data: loops, meta: { page: 0, limit: 50, total } },
    isLoading: false,
    error: null,
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.keyword = "";
  mocks.list = { data: undefined, isLoading: false, error: null };
});
afterEach(cleanup);

describe("Loops list", () => {
  it("shows the empty splash for a project with no Loops, with no table and no header action", () => {
    withLoops([]);
    render(<LoopsPage />);
    expect(screen.getByText("Get started with Loops")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByRole("button", { name: "New Loop" })).toBeNull();
    expect(screen.getByRole("link", { name: /New Loop/ }).getAttribute("href")).toBe(
      "/projects/proj-1/loops/new",
    );
  });

  it("lists each Loop with its status, schedule, next run in its zone, last outcome, cost and signals", () => {
    withLoops([
      loop(),
      loop({
        id: "l2",
        name: "Flaky sweep",
        status: "paused",
        nextRunAt: null,
        lastRun: null,
        runCount: 0,
        avgCostUsd: null,
        signalCount: 0,
      }),
    ]);
    render(<LoopsPage />);
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    const first = within(rows[0]);
    expect(first.getByText("Active")).toBeTruthy();
    expect(first.getByText("Daily at 09:00 Europe/Berlin")).toBeTruthy();
    expect(first.getByText("Thu 12 Nov, 09:00 CET")).toBeTruthy();
    expect(first.getByText(/Succeeded · 2 findings/)).toBeTruthy();
    expect(first.getByText("$0.3332")).toBeTruthy();
    const signals = first.getByRole("link", { name: "View signals found by Coding agents" });
    expect(decodeURIComponent(signals.getAttribute("href")!)).toContain(
      '"field":"detector_id","op":"eq","value":"d1"',
    );
    const second = within(rows[1]);
    expect(second.getByText("Paused")).toBeTruthy();
    expect(second.getByText("Never run")).toBeTruthy();
    expect(second.getAllByText("—").length).toBeGreaterThan(0); // no next run while paused
  });

  it("marks a dry-run Loop and opens the reason of a system pause", () => {
    withLoops([
      loop({ dryRun: true }),
      loop({
        id: "l3",
        name: "Regressions",
        status: "paused_by_system",
        pauseReason: "failures",
        failureStreak: 5,
      }),
    ]);
    render(<LoopsPage />);
    expect(screen.getByText("Dry run")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Paused by system" }));
    expect(screen.getByText(/5 scheduled runs in a row failed/)).toBeTruthy();
  });

  it("reads each last-run outcome the Runs tab will show", () => {
    withLoops([
      loop({ id: "a", name: "A", lastRun: run("quiet") }),
      loop({
        id: "b",
        name: "B",
        lastRun: run("failed", { error: "BYOK gone" }),
      }),
      loop({ id: "c", name: "C", lastRun: run("skipped_precheck") }),
      loop({ id: "d", name: "D", lastRun: run("pending", { startedAt: null }) }),
    ]);
    render(<LoopsPage />);
    for (const text of ["Quiet", "Failed", "Skipped (no new traces)", "Queued"]) {
      expect(screen.getByText(text)).toBeTruthy();
    }
    expect(screen.getByText("Failed").closest("span")?.getAttribute("title")).toBe("BYOK gone");
  });

  it("pauses an active Loop and resumes a stopped one from the row menu", () => {
    withLoops([
      loop(),
      loop({ id: "l2", name: "Stopped", status: "paused_by_system", pauseReason: "failures" }),
    ]);
    render(<LoopsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Actions for Coding agents" }));
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(mocks.setStatus).toHaveBeenCalledWith({ loopId: "l1", action: "pause" });
    fireEvent.click(screen.getByRole("button", { name: "Actions for Stopped" }));
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(mocks.setStatus).toHaveBeenLastCalledWith({ loopId: "l2", action: "resume" });
  });

  it("deletes only after the name is typed", () => {
    withLoops([loop()]);
    render(<LoopsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Actions for Coding agents" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const confirm = screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText("Coding agents"), {
      target: { value: "Coding agents" },
    });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(mocks.deleteLoop).toHaveBeenCalledWith("l1", expect.any(Object));
  });

  it("opens a row on click, but not when its signal count or menu is clicked", () => {
    withLoops([loop()]);
    render(<LoopsPage />);
    fireEvent.click(screen.getByRole("link", { name: /View signals found by/ }));
    fireEvent.click(screen.getByRole("button", { name: "Actions for Coding agents" }));
    expect(mocks.push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Daily at 09:00 Europe/Berlin"));
    expect(mocks.push).toHaveBeenCalledWith("/projects/proj-1/loops/l1");
  });

  it("disables New Loop at five Loops and says why", () => {
    withLoops(Array.from({ length: 5 }, (_, i) => loop({ id: `l${i}`, name: `Loop ${i}` })));
    render(<LoopsPage />);
    expect((screen.getByRole("button", { name: "New Loop" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText("5 of 5 Loops used")).toBeTruthy();
  });

  it("offers New Loop below the limit", () => {
    withLoops([loop()]);
    render(<LoopsPage />);
    const button = screen.getByRole("button", { name: "New Loop" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(mocks.push).toHaveBeenCalledWith("/projects/proj-1/loops/new");
  });

  it("handles a search with no match and a load error", () => {
    mocks.keyword = "zzz";
    withLoops([], 0);
    const { unmount } = render(<LoopsPage />);
    expect(screen.getByText(/No Loops match/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(mocks.updateKeyword).toHaveBeenCalledWith("");
    unmount();
    mocks.keyword = "";
    mocks.list = { data: undefined, isLoading: false, error: new Error("boom") };
    render(<LoopsPage />);
    expect(screen.getByText("Error loading Loops")).toBeTruthy();
    expect(screen.getByText("boom")).toBeTruthy();
  });
});

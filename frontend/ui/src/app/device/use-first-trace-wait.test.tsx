// @vitest-environment jsdom
/**
 * The wait's three outcomes, plus the two properties that make it safe to leave
 * running in a tab nobody is looking at: it never overlaps its own rounds, and
 * an unmount stops it dead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  readWatchedProjects: vi.fn(),
  captureTraceBaseline: vi.fn(),
  retryUnknownBaseline: vi.fn(),
  findFirstTrace: vi.fn(),
}));

vi.mock("./first-trace", () => ({
  readWatchedProjects: (...args: unknown[]) => mocks.readWatchedProjects(...args),
  watchOrder: (projects: { id: string }[]) => projects.map((project) => project.id),
}));

vi.mock("@/lib/first-trace", () => ({
  captureTraceBaseline: (...args: unknown[]) => mocks.captureTraceBaseline(...args),
  retryUnknownBaseline: (...args: unknown[]) => mocks.retryUnknownBaseline(...args),
  findFirstTrace: (...args: unknown[]) => mocks.findFirstTrace(...args),
}));

import { POLL_INTERVAL_MS, WAIT_BUDGET_MS } from "@/lib/hooks/use-trace-wait";
import { MAX_BARREN_ROUNDS, useFirstTraceWait } from "./use-first-trace-wait";
import type { Project, Workspace } from "@/types/api";

const WORKSPACES: Workspace[] = [
  { id: "ws-1", name: "Acme", role: "ADMIN", create_time: "2026-01-01T00:00:00Z" },
];

const PROJECT: Project = {
  id: "p-1",
  name: "service",
  trace_ttl_days: null,
  create_time: "2026-01-01T00:00:00Z",
};

/** A project that only becomes visible part-way through a wait. */
const LATE_PROJECT: Project = {
  id: "p-2",
  name: "other",
  trace_ttl_days: null,
  create_time: "2026-02-01T00:00:00Z",
};

/** The whole account, read without incident. */
const WHOLE_ACCOUNT = { projects: [PROJECT], complete: true };

/**
 * Drain the microtask queue. The rounds are several awaits deep, and under fake
 * timers nothing else will advance them — testing-library's own waitFor polls on
 * real timers, so it would simply hang here.
 */
async function flush() {
  await act(async () => {
    for (let turn = 0; turn < 20; turn += 1) {
      await Promise.resolve();
    }
  });
}

/** Let the in-flight round settle, then fire the next timeout and settle that. */
async function nextRound() {
  await flush();
  await act(async () => {
    vi.advanceTimersByTime(POLL_INTERVAL_MS);
  });
  await flush();
}

function watch(active = true) {
  return renderHook(() => useFirstTraceWait(active, WORKSPACES, { id: "u-1" }));
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.readWatchedProjects.mockResolvedValue(WHOLE_ACCOUNT);
  mocks.captureTraceBaseline.mockResolvedValue(new Map([["p-1", { kind: "empty" }]]));
  mocks.retryUnknownBaseline.mockImplementation(async (baseline: unknown) => baseline);
  mocks.findFirstTrace.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  mocks.readWatchedProjects.mockReset();
  mocks.captureTraceBaseline.mockReset();
  mocks.retryUnknownBaseline.mockReset();
  mocks.findFirstTrace.mockReset();
});

describe("useFirstTraceWait", () => {
  it("starts out waiting", () => {
    const { result } = watch();
    expect(result.current).toEqual({ kind: "waiting" });
  });

  it("does nothing at all until it is active", async () => {
    renderHook(() => useFirstTraceWait(false, WORKSPACES, { id: "u-1" }));
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS * 3);
    });
    expect(mocks.readWatchedProjects).not.toHaveBeenCalled();
  });

  it("draws the baseline before looking, so a pre-existing trace cannot win", async () => {
    watch();

    await flush();

    // The first round reads the account and records where its traces already
    // stood. Nothing is matched against it yet.
    expect(mocks.captureTraceBaseline).toHaveBeenCalledWith(["p-1"], { id: "u-1" });
    expect(mocks.findFirstTrace).not.toHaveBeenCalled();
  });

  it("gives a baseline that failed another go before matching against it", async () => {
    const settled = new Map([["p-1", { kind: "newest", at: "2026-05-01T10:00:00Z" }]]);
    mocks.captureTraceBaseline.mockResolvedValue(new Map([["p-1", { kind: "unknown" }]]));
    mocks.retryUnknownBaseline.mockResolvedValue(settled);
    watch();

    await nextRound();

    expect(mocks.retryUnknownBaseline).toHaveBeenCalled();
    // The search takes ids, ranked by `watchOrder` before it is called.
    expect(mocks.findFirstTrace).toHaveBeenCalledWith([PROJECT.id], settled, { id: "u-1" });
  });

  it("keeps waiting while no trace has arrived", async () => {
    const { result } = watch();

    await nextRound();
    await nextRound();

    expect(mocks.findFirstTrace).toHaveBeenCalled();
    expect(result.current).toEqual({ kind: "waiting" });
  });

  it("settles on the trace once one arrives, and stops looking", async () => {
    const { result } = watch();
    await nextRound();

    mocks.findFirstTrace.mockResolvedValue({ projectId: "p-1", traceId: "t-1" });
    await nextRound();

    expect(result.current).toEqual({
      kind: "found",
      found: { projectId: "p-1", traceId: "t-1" },
    });

    const roundsSoFar = mocks.findFirstTrace.mock.calls.length;
    await nextRound();
    expect(mocks.findFirstTrace.mock.calls.length).toBe(roundsSoFar);
  });

  it("gives up when the budget runs out, offering the project it was watching", async () => {
    const { result } = watch();

    await flush();
    // One tick past the budget is all it takes; the loop refuses to schedule a
    // round it knows would land outside it.
    await act(async () => {
      vi.advanceTimersByTime(WAIT_BUDGET_MS);
    });
    await flush();

    expect(result.current).toEqual({ kind: "gave-up", fallbackUrl: "/projects/p-1/traces" });
  });

  it("gives up early, pointing at the workspace list, when it can read nothing", async () => {
    // Reaching this panel means the account had a project moments ago, so a
    // round that finds none could not read the account. Saying so beats
    // spinning out the whole budget.
    mocks.readWatchedProjects.mockResolvedValue({ projects: [], complete: true });
    const { result } = watch();

    for (let round = 0; round < MAX_BARREN_ROUNDS; round += 1) {
      await nextRound();
    }

    expect(result.current).toEqual({ kind: "gave-up", fallbackUrl: "/workspaces" });
    expect(mocks.captureTraceBaseline).not.toHaveBeenCalled();
  });

  it("recovers from a blip rather than ending the wait on it", async () => {
    mocks.readWatchedProjects.mockResolvedValueOnce({ projects: [], complete: true });
    const { result } = watch();

    await nextRound();
    await nextRound();

    expect(result.current).toEqual({ kind: "waiting" });
    expect(mocks.captureTraceBaseline).toHaveBeenCalled();
  });

  it("never overlaps rounds, even when one takes longer than the interval", async () => {
    let release: (watched: typeof WHOLE_ACCOUNT) => void = () => {};
    mocks.readWatchedProjects.mockReturnValueOnce(
      new Promise<typeof WHOLE_ACCOUNT>((resolve) => {
        release = resolve;
      }),
    );
    watch();

    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS * 4);
    });
    await flush();
    // The next round is only scheduled once the current one has finished, so a
    // stalled read cannot pile up a queue of concurrent probes.
    expect(mocks.readWatchedProjects).toHaveBeenCalledTimes(1);

    await act(async () => {
      release(WHOLE_ACCOUNT);
    });
    await flush();
  });

  it("draws a line for a project that appears after a round it could not read in full", async () => {
    // Absence from the baseline is what marks a project as the terminal's, and
    // that only holds if the baseline saw the whole account. A workspace that
    // failed to list leaves a project that was there all along looking new —
    // and then its months-old traces qualify and the tab opens the wrong one.
    mocks.readWatchedProjects
      .mockResolvedValueOnce({ projects: [PROJECT], complete: false })
      .mockResolvedValue({ projects: [PROJECT, LATE_PROJECT], complete: true });
    mocks.captureTraceBaseline
      .mockResolvedValueOnce(new Map([["p-1", { kind: "empty" }]]))
      .mockResolvedValueOnce(new Map([["p-2", { kind: "newest", at: "2026-05-01T10:00:00Z" }]]));
    watch();

    await nextRound();

    expect(mocks.captureTraceBaseline).toHaveBeenCalledTimes(2);
    expect(mocks.captureTraceBaseline).toHaveBeenLastCalledWith(["p-2"], { id: "u-1" });
    // And the search gets that line, rather than searching p-2 with none.
    const searched = mocks.findFirstTrace.mock.calls[0][1] as Map<string, unknown>;
    expect(searched.get("p-2")).toEqual({ kind: "newest", at: "2026-05-01T10:00:00Z" });
  });

  it("leaves a project that appears after a complete round unlined, so the terminal's own ranks first", async () => {
    // The other half of the same rule: when the first round did see the whole
    // account, a project that was not in it did not exist, and everything in it
    // belongs to the run that just authorized.
    mocks.readWatchedProjects
      .mockResolvedValueOnce(WHOLE_ACCOUNT)
      .mockResolvedValue({ projects: [PROJECT, LATE_PROJECT], complete: true });
    watch();

    await nextRound();

    expect(mocks.captureTraceBaseline).toHaveBeenCalledTimes(1);
    const searched = mocks.findFirstTrace.mock.calls[0][1] as Map<string, unknown>;
    expect(searched.has("p-2")).toBe(false);
  });

  it("stops on unmount, leaving no timer and no late state write", async () => {
    const { unmount } = watch();
    await nextRound();
    const roundsBefore = mocks.readWatchedProjects.mock.calls.length;

    unmount();
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS * 5);
    });
    await flush();

    expect(mocks.readWatchedProjects.mock.calls.length).toBe(roundsBefore);
    expect(vi.getTimerCount()).toBe(0);
  });
});

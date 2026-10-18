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
  captureTraceBaseline: (...args: unknown[]) => mocks.captureTraceBaseline(...args),
  retryUnknownBaseline: (...args: unknown[]) => mocks.retryUnknownBaseline(...args),
  findFirstTrace: (...args: unknown[]) => mocks.findFirstTrace(...args),
}));

import {
  MAX_BARREN_ROUNDS,
  POLL_INTERVAL_MS,
  WAIT_BUDGET_MS,
  useFirstTraceWait,
} from "./use-first-trace-wait";
import type { BaselineEntry, WatchedProjects } from "./first-trace";
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

/** One round's listing, with nothing added on key evidence unless `keyed` says so. */
function watched(projects: Project[], keyed: string[] = []): WatchedProjects {
  return { projects, keyed, keyCounts: new Map() };
}

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
  mocks.readWatchedProjects.mockResolvedValue(watched([PROJECT]));
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
    expect(mocks.findFirstTrace).toHaveBeenCalledWith([PROJECT], settled, { id: "u-1" });
  });

  it("carries each round's key counts into the next", async () => {
    // The counts are what a project gaining a key is measured against, so a
    // round that dropped them would start every comparison from nothing.
    const counts = new Map([["p-1", 1]]);
    mocks.readWatchedProjects.mockResolvedValueOnce({
      projects: [PROJECT],
      keyed: [],
      keyCounts: counts,
    });
    watch();

    await nextRound();

    expect(mocks.readWatchedProjects.mock.calls[0][1]).toEqual(new Map());
    expect(mocks.readWatchedProjects.mock.calls[1][1]).toBe(counts);
  });

  it("draws a line for a project that joined on a new key before looking in it", async () => {
    // It existed before approval, so it is not one the terminal created, and
    // with no line the traces it already held would pass for the run's.
    const older: Project = {
      id: "p-old",
      name: "legacy",
      trace_ttl_days: null,
      create_time: "2025-01-01T00:00:00Z",
    };
    const oldLine: BaselineEntry = { kind: "newest", at: "2026-04-01T10:00:00Z" };
    watch();
    await flush();
    mocks.readWatchedProjects.mockResolvedValue(watched([PROJECT, older], ["p-old"]));
    mocks.captureTraceBaseline.mockResolvedValueOnce(new Map([["p-old", oldLine]]));

    await nextRound();

    expect(mocks.captureTraceBaseline).toHaveBeenLastCalledWith(["p-old"], { id: "u-1" });
    expect(mocks.findFirstTrace).toHaveBeenCalledWith(
      [PROJECT, older],
      new Map<string, BaselineEntry>([
        ["p-1", { kind: "empty" }],
        ["p-old", oldLine],
      ]),
      { id: "u-1" },
    );

    // Drawn once. A later round compares against the same line.
    await nextRound();
    expect(mocks.captureTraceBaseline).toHaveBeenCalledTimes(2);
  });

  it("draws no line past the first while nothing joins on a key", async () => {
    watch();

    await nextRound();
    await nextRound();
    await nextRound();

    expect(mocks.captureTraceBaseline).toHaveBeenCalledTimes(1);
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
    mocks.readWatchedProjects.mockResolvedValue(watched([]));
    const { result } = watch();

    for (let round = 0; round < MAX_BARREN_ROUNDS; round += 1) {
      await nextRound();
    }

    expect(result.current).toEqual({ kind: "gave-up", fallbackUrl: "/workspaces" });
    expect(mocks.captureTraceBaseline).not.toHaveBeenCalled();
  });

  it("recovers from a blip rather than ending the wait on it", async () => {
    mocks.readWatchedProjects.mockResolvedValueOnce(watched([]));
    const { result } = watch();

    await nextRound();
    await nextRound();

    expect(result.current).toEqual({ kind: "waiting" });
    expect(mocks.captureTraceBaseline).toHaveBeenCalled();
  });

  it("never overlaps rounds, even when one takes longer than the interval", async () => {
    let release: (projects: WatchedProjects) => void = () => {};
    mocks.readWatchedProjects.mockReturnValueOnce(
      new Promise<WatchedProjects>((resolve) => {
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
      release(watched([PROJECT]));
    });
    await flush();
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

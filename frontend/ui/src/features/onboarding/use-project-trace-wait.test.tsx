// @vitest-environment jsdom
/**
 * What onboarding adds to the shared wait, which is little and deliberately so:
 * one project it knows it made, a line drawn across it before anything can
 * match, and a wait that starts over if the project it was handed changes.
 *
 * The pacing, the budget and the cancellation are `useTraceWait`'s and are
 * tested there. The search is `lib/first-trace`'s and is tested there. What is
 * left is this page's own reasoning, and it is what the mocks below observe.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  captureTraceBaseline: vi.fn(),
  retryUnknownBaseline: vi.fn(),
  findFirstTrace: vi.fn(),
}));

vi.mock("@/lib/first-trace", () => ({
  captureTraceBaseline: (...args: unknown[]) => mocks.captureTraceBaseline(...args),
  retryUnknownBaseline: (...args: unknown[]) => mocks.retryUnknownBaseline(...args),
  findFirstTrace: (...args: unknown[]) => mocks.findFirstTrace(...args),
}));

import { POLL_INTERVAL_MS, WAIT_BUDGET_MS } from "@/lib/hooks/use-trace-wait";
import { useProjectTraceWait } from "./use-project-trace-wait";

const USER = { id: "u-1" };
const FOUND = { projectId: "p-1", traceId: "t-1" };

/**
 * Drain the microtask queue. A round is several awaits deep, and under fake
 * timers nothing else will advance it — testing-library's own waitFor polls on
 * real ones, so it would simply hang here.
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

function watch(projectId: string | null = "p-1", active = true) {
  return renderHook(() => useProjectTraceWait(active, projectId, USER));
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.captureTraceBaseline.mockResolvedValue(new Map([["p-1", { kind: "empty" }]]));
  mocks.retryUnknownBaseline.mockImplementation(async (baseline: unknown) => baseline);
  mocks.findFirstTrace.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  mocks.captureTraceBaseline.mockReset();
  mocks.retryUnknownBaseline.mockReset();
  mocks.findFirstTrace.mockReset();
});

describe("useProjectTraceWait", () => {
  it("does not start before the page has a project to watch", async () => {
    const { result } = watch(null);

    await flush();

    expect(mocks.captureTraceBaseline).not.toHaveBeenCalled();
    expect(result.current).toEqual({ kind: "waiting" });
  });

  it("does nothing at all until it is active", async () => {
    watch("p-1", false);

    await flush();

    expect(mocks.captureTraceBaseline).not.toHaveBeenCalled();
  });

  it("draws the line before looking, so a project it did not really create cannot match", async () => {
    // Project creation is idempotent on the name within a workspace, so a run
    // that reuses a name is handed the existing project back, traces and all.
    // Without a line drawn first, the first round would "find" one of those.
    watch();

    await flush();

    expect(mocks.captureTraceBaseline).toHaveBeenCalledWith(["p-1"], USER);
    expect(mocks.findFirstTrace).not.toHaveBeenCalled();
  });

  it("gives a baseline that failed another go before matching against it", async () => {
    const settled = new Map([["p-1", { kind: "newest", at: "2026-05-01T10:00:00Z" }]]);
    mocks.captureTraceBaseline.mockResolvedValue(new Map([["p-1", { kind: "unknown" }]]));
    mocks.retryUnknownBaseline.mockResolvedValue(settled);
    watch();

    await nextRound();

    expect(mocks.retryUnknownBaseline).toHaveBeenCalled();
    expect(mocks.findFirstTrace).toHaveBeenCalledWith(["p-1"], settled, USER);
  });

  it("opens the trace once one arrives, and stops looking", async () => {
    const { result } = watch();
    await nextRound();

    mocks.findFirstTrace.mockResolvedValue(FOUND);
    await nextRound();

    expect(result.current).toEqual({ kind: "found", found: FOUND });

    const roundsSoFar = mocks.findFirstTrace.mock.calls.length;
    await nextRound();
    expect(mocks.findFirstTrace.mock.calls.length).toBe(roundsSoFar);
  });

  it("starts over when it is handed a different project", async () => {
    const { result, rerender } = renderHook(
      ({ projectId }: { projectId: string }) => useProjectTraceWait(true, projectId, USER),
      { initialProps: { projectId: "p-1" } },
    );
    mocks.findFirstTrace.mockResolvedValue(FOUND);
    await nextRound();
    expect(result.current).toEqual({ kind: "found", found: FOUND });

    mocks.findFirstTrace.mockResolvedValue(null);
    rerender({ projectId: "p-2" });

    // The old project's trace is not this project's answer, and the baseline
    // that excluded its history says nothing about the new one.
    expect(result.current).toEqual({ kind: "waiting" });
    await flush();
    expect(mocks.captureTraceBaseline).toHaveBeenLastCalledWith(["p-2"], USER);
  });

  it("gives up on the project's own traces page when the budget runs out", async () => {
    // The setup is still running wherever the command was run, so the way out
    // is the page the trace will appear on whenever it does arrive.
    const { result } = watch();

    await flush();
    await act(async () => {
      vi.advanceTimersByTime(WAIT_BUDGET_MS);
    });
    await flush();

    expect(result.current).toEqual({ kind: "gave-up", fallbackUrl: "/projects/p-1/traces" });
  });
});

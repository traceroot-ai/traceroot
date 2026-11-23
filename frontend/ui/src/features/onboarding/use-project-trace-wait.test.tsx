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
import { MAX_UNREADABLE_ROUNDS, useProjectTraceWait } from "./use-project-trace-wait";

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

    // With the arguments: a retry handed an empty map, the wrong map or no user
    // settles nothing and would still pass a bare call assertion.
    expect(mocks.retryUnknownBaseline).toHaveBeenCalledWith(
      new Map([["p-1", { kind: "unknown" }]]),
      USER,
    );
    expect(mocks.findFirstTrace).toHaveBeenCalledWith("p-1", settled, USER);
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

  it("stops early, and says why, when the project stays unreadable", async () => {
    // A session that expires mid-wait leaves the line undrawn, and a project
    // with no line can never match — `findFirstTrace` skips it. Without this
    // the page would spend the whole ten minutes and then report that no trace
    // arrived, which is a claim about the run it is in no position to make.
    mocks.captureTraceBaseline.mockResolvedValue(new Map([["p-1", { kind: "unknown" }]]));
    const { result } = watch();

    for (let round = 0; round < MAX_UNREADABLE_ROUNDS; round += 1) {
      await nextRound();
    }

    expect(result.current).toEqual({
      kind: "gave-up",
      fallbackUrl: "/projects/p-1/traces",
      unreadable: true,
    });
    // And it never searched: there was nothing to compare a trace against.
    expect(mocks.findFirstTrace).not.toHaveBeenCalled();
  });

  it("treats one unreadable round as a blip rather than an ending", async () => {
    mocks.captureTraceBaseline.mockResolvedValue(new Map([["p-1", { kind: "unknown" }]]));
    mocks.retryUnknownBaseline
      .mockResolvedValueOnce(new Map([["p-1", { kind: "unknown" }]]))
      .mockResolvedValue(new Map([["p-1", { kind: "empty" }]]));
    const { result } = watch();

    await nextRound();
    await nextRound();

    expect(result.current).toEqual({ kind: "waiting" });
    expect(mocks.findFirstTrace).toHaveBeenCalledWith(
      "p-1",
      new Map([["p-1", { kind: "empty" }]]),
      USER,
    );
  });

  it("stops early, and says why, when the search stops being able to read", async () => {
    // The line was drawn, so the baseline has nothing to say about a session
    // that expires afterwards. Without counting the search, the page would wait
    // out the budget and then report that no trace arrived.
    mocks.findFirstTrace.mockRejectedValue(new Error("unauthorized"));
    const { result } = watch();

    // The first round only draws the line, and the round past the limit shows
    // that the wait stopped searching rather than carrying on.
    for (let round = 0; round <= MAX_UNREADABLE_ROUNDS; round += 1) {
      await nextRound();
    }

    expect(mocks.findFirstTrace).toHaveBeenCalledTimes(MAX_UNREADABLE_ROUNDS);
    expect(result.current).toEqual({
      kind: "gave-up",
      fallbackUrl: "/projects/p-1/traces",
      unreadable: true,
    });
  });

  it("starts the count over once a search reads the project", async () => {
    // Failures that a good read separates are blips, not a tab that has lost
    // the account, so only a run of them in a row ends the wait.
    for (let failure = 1; failure < MAX_UNREADABLE_ROUNDS; failure += 1) {
      mocks.findFirstTrace.mockRejectedValueOnce(new Error("offline"));
    }
    mocks.findFirstTrace.mockResolvedValueOnce(null);
    mocks.findFirstTrace.mockRejectedValue(new Error("offline"));
    const { result } = watch();

    // After the round that draws the line: failures to one short of the limit,
    // the good read, then as many again — past the limit had it not reset.
    for (let round = 0; round < 2 * MAX_UNREADABLE_ROUNDS - 1; round += 1) {
      await nextRound();
    }

    expect(mocks.findFirstTrace).toHaveBeenCalledTimes(2 * MAX_UNREADABLE_ROUNDS - 1);
    expect(result.current).toEqual({ kind: "waiting" });
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

// @vitest-environment jsdom
/**
 * The loop both setup flows run their rounds on: what it does with each answer
 * a round can give, and the two properties that make it safe to leave running
 * in a tab nobody is looking at — it never overlaps its own rounds, and an
 * unmount stops it dead.
 *
 * The rounds here are stubs. What each page actually looks at is its own
 * business and is tested with that page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

import { POLL_INTERVAL_MS, WAIT_BUDGET_MS, useTraceWait, type RoundResult } from "./use-trace-wait";

const FOUND = { projectId: "p-1", traceId: "t-1" };
const AGAIN: RoundResult = { kind: "again", fallbackUrl: "/projects/p-1/traces" };

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

/** A wait whose rounds answer from `answers`, repeating the last one. */
function watchWith(answers: RoundResult[], active = true) {
  const round = vi.fn(
    async () => answers[Math.min(round.mock.calls.length - 1, answers.length - 1)],
  );
  const rendered = renderHook(() => useTraceWait(active, () => round, "key"));
  return { round, ...rendered };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useTraceWait", () => {
  it("does not start a round while it is inactive", async () => {
    const { round, result } = watchWith([AGAIN], false);

    await flush();

    expect(round).not.toHaveBeenCalled();
    expect(result.current).toEqual({ kind: "waiting" });
  });

  it("keeps waiting for as long as its rounds say to come back", async () => {
    const { round, result } = watchWith([AGAIN]);

    await flush();
    expect(round).toHaveBeenCalledTimes(1);

    await nextRound();

    expect(round).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual({ kind: "waiting" });
  });

  it("settles on the trace a round found", async () => {
    const { result } = watchWith([AGAIN, { kind: "found", found: FOUND }]);

    await flush();
    await nextRound();

    expect(result.current).toEqual({ kind: "found", found: FOUND });
  });

  it("runs no further rounds once it has found one", async () => {
    const { round } = watchWith([{ kind: "found", found: FOUND }]);

    await flush();
    await nextRound();

    expect(round).toHaveBeenCalledTimes(1);
  });

  it("gives up where the round says to when the round says to stop", async () => {
    const { result } = watchWith([{ kind: "stop", fallbackUrl: "/workspaces" }]);

    await flush();

    expect(result.current).toEqual({ kind: "gave-up", fallbackUrl: "/workspaces" });
  });

  it("gives up when the budget runs out, pointing where the last round said", async () => {
    // The outcome a spinner must never have: a wait that ends with nothing is
    // still a wait that ends, and it hands over the way in that the round it
    // ran last had found.
    const { result } = watchWith([AGAIN]);

    await flush();
    for (let elapsed = 0; elapsed < WAIT_BUDGET_MS; elapsed += POLL_INTERVAL_MS) {
      await nextRound();
    }

    expect(result.current).toEqual({ kind: "gave-up", fallbackUrl: AGAIN.fallbackUrl });
  });

  it("never lets one round overlap the next", async () => {
    // The reason this is a chain of timeouts and not an interval: a round that
    // takes longer than the interval would otherwise be racing a second copy of
    // itself against the same state.
    let release: (() => void) | undefined;
    const round = vi.fn(
      () =>
        new Promise<RoundResult>((resolve) => {
          release = () => resolve(AGAIN);
        }),
    );
    renderHook(() => useTraceWait(true, () => round, "key"));

    await flush();
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS * 5);
    });
    await flush();

    // Still the first round, five intervals later: nothing scheduled the second.
    expect(round).toHaveBeenCalledTimes(1);

    release?.();
    await nextRound();

    expect(round).toHaveBeenCalledTimes(2);
  });

  it("stops dead when the tab goes away", async () => {
    const { round, unmount } = watchWith([AGAIN]);

    await flush();
    expect(round).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS * 3);
    });
    await flush();

    expect(round).toHaveBeenCalledTimes(1);
  });

  it("hands the round a way to notice it has been cancelled", async () => {
    // A round is several reads deep. Without this it would go on fetching the
    // rest of them for a page the user has already left.
    let seen: (() => boolean) | undefined;
    const { unmount } = renderHook(() =>
      useTraceWait(
        true,
        (isCancelled) => {
          seen = isCancelled;
          return async () => AGAIN;
        },
        "key",
      ),
    );
    await flush();

    expect(seen?.()).toBe(false);
    unmount();
    expect(seen?.()).toBe(true);
  });

  it("does nothing with a round that stopped half-way", async () => {
    const { result } = watchWith([{ kind: "found", found: FOUND }]);
    const stopped = renderHook(() => useTraceWait(true, () => async () => null, "other"));

    await flush();

    expect(stopped.result.current).toEqual({ kind: "waiting" });
    // The sibling wait is unaffected: stopping is per-round, not global.
    expect(result.current).toEqual({ kind: "found", found: FOUND });
  });

  it("allocates the round once per wait, not once per round", async () => {
    // Where a wait's state lives: a baseline drawn on the first round has to
    // survive to the second, and must not survive a restart.
    const beginWait = vi.fn(() => vi.fn(async (): Promise<RoundResult> => AGAIN));
    renderHook(() => useTraceWait(true, beginWait, "key"));

    await flush();
    await nextRound();
    await nextRound();

    expect(beginWait).toHaveBeenCalledTimes(1);
  });
});

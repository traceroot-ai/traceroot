// @vitest-environment jsdom
/**
 * The loop a first-trace wait runs its rounds on: what it does with each answer
 * a round can give, and the two properties that make it safe to leave running
 * in a tab nobody is looking at — it never overlaps its own rounds, and an
 * unmount stops it dead.
 *
 * The rounds here are stubs. What the page actually looks at is its own
 * business and is tested with that page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

import { POLL_INTERVAL_MS, WAIT_BUDGET_MS, useTraceWait, type RoundResult } from "./use-trace-wait";

const FOUND = { projectId: "p-1", traceId: "t-1" };
const AGAIN: RoundResult = { kind: "again", fallbackUrl: "/projects/p-1/traces" };
/** The caller's standing answer, used until a round reports a better one. */
const LAST_RESORT = "/workspaces";

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
  const rendered = renderHook(() => useTraceWait(active, () => round, "key", LAST_RESORT));
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

  it("passes on that a round stopped because it could not read", async () => {
    // The page says a different thing in that case, and it can only say it if
    // this loop carries the distinction rather than flattening it.
    const { result } = watchWith([{ kind: "stop", fallbackUrl: "/workspaces", unreadable: true }]);

    await flush();

    expect(result.current).toEqual({
      kind: "gave-up",
      fallbackUrl: "/workspaces",
      unreadable: true,
    });
  });

  it("starts a round as soon as the tab comes back, rather than waiting the interval out", async () => {
    // Hidden is this wait's normal state — the person was sent to their
    // terminal — and a hidden tab's timers are throttled to roughly one a
    // minute. Noticing on return is what keeps that from deciding how long a
    // trace takes to show up.
    const { round } = watchWith([AGAIN]);

    await flush();
    expect(round).toHaveBeenCalledTimes(1);

    // Mid-interval: nothing is due yet.
    await act(async () => {
      vi.advanceTimersByTime(POLL_INTERVAL_MS / 2);
    });
    await flush();
    expect(round).toHaveBeenCalledTimes(1);

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flush();

    expect(round).toHaveBeenCalledTimes(2);
  });

  it("adds no round alongside one still in flight when the tab comes back", async () => {
    // The kick must not cost the no-overlap property below it: a round is
    // several reads deep, and two of them racing one baseline is exactly what
    // the chain of timeouts exists to prevent.
    let release: (() => void) | undefined;
    const round = vi.fn(
      () =>
        new Promise<RoundResult>((resolve) => {
          release = () => resolve(AGAIN);
        }),
    );
    renderHook(() => useTraceWait(true, () => round, "key", LAST_RESORT));

    await flush();
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flush();

    expect(round).toHaveBeenCalledTimes(1);

    release?.();
    await flush();
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
    renderHook(() => useTraceWait(true, () => round, "key", LAST_RESORT));

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
      // Not on a timer, and not on the tab coming back either.
      document.dispatchEvent(new Event("visibilitychange"));
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
        LAST_RESORT,
      ),
    );
    await flush();

    expect(seen?.()).toBe(false);
    unmount();
    expect(seen?.()).toBe(true);
  });

  it("does nothing with a round that stopped half-way", async () => {
    const { result } = watchWith([{ kind: "found", found: FOUND }]);
    const stopped = renderHook(() =>
      useTraceWait(true, () => async () => null, "other", LAST_RESORT),
    );

    await flush();

    expect(stopped.result.current).toEqual({ kind: "waiting" });
    // The sibling wait is unaffected: stopping is per-round, not global.
    expect(result.current).toEqual({ kind: "found", found: FOUND });
  });

  it("allocates the round once per wait, not once per round", async () => {
    // Where a wait's state lives: a baseline drawn on the first round has to
    // survive to the second, and must not survive a restart.
    const beginWait = vi.fn(() => vi.fn(async (): Promise<RoundResult> => AGAIN));
    renderHook(() => useTraceWait(true, beginWait, "key", LAST_RESORT));

    await flush();
    await nextRound();
    await nextRound();

    expect(beginWait).toHaveBeenCalledTimes(1);
  });

  it("starts over, visibly, when the identity it follows changes", async () => {
    // The previous account's trace is not this account's answer. Leaving it on
    // screen would offer a link into somewhere the new wait has nothing to do
    // with, and the baseline that found it lives in the old factory's closure.
    const beginWait = vi.fn(() =>
      vi.fn(async (): Promise<RoundResult> => ({ kind: "found", found: FOUND })),
    );
    const { result, rerender } = renderHook(
      ({ identity }: { identity: string }) => useTraceWait(true, beginWait, identity, LAST_RESORT),
      { initialProps: { identity: "acct-1" } },
    );

    await flush();
    expect(result.current).toEqual({ kind: "found", found: FOUND });

    rerender({ identity: "acct-2" });

    expect(result.current).toEqual({ kind: "waiting" });
    expect(beginWait).toHaveBeenCalledTimes(2);
  });

  it("ends on its deadline even when a round never answers at all", async () => {
    // The budget is a deadline on the wait, not a check made between rounds:
    // `fetch` has no timeout of its own, so one read that never resolves would
    // otherwise leave the page spinning for good.
    const round = vi.fn(() => new Promise<RoundResult>(() => {}));
    const { result } = renderHook(() => useTraceWait(true, () => round, "key", LAST_RESORT));

    await flush();
    await act(async () => {
      vi.advanceTimersByTime(WAIT_BUDGET_MS);
    });
    await flush();

    // Nothing ever reported a way out, so the caller's standing one is used.
    expect(result.current).toEqual({ kind: "gave-up", fallbackUrl: LAST_RESORT });
    expect(round).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("comes back from a round that threw instead of stopping dead", async () => {
    // A throw used to skip the state write and the next timer both, leaving a
    // wait that spun on "waiting" with nothing scheduled and no way out.
    let calls = 0;
    const round = vi.fn(async (): Promise<RoundResult> => {
      calls += 1;
      if (calls === 1) {
        throw new Error("boom");
      }
      return { kind: "found", found: FOUND };
    });
    const { result } = renderHook(() => useTraceWait(true, () => round, "key", LAST_RESORT));

    await flush();
    expect(result.current).toEqual({ kind: "waiting" });

    await nextRound();

    expect(round).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual({ kind: "found", found: FOUND });
  });

  it("drops a round that answers after the tab has gone", async () => {
    // Cancellation has to survive the gap between a round's last read and its
    // answer, because the state write is on the far side of that await.
    let release: ((result: RoundResult) => void) | undefined;
    const round = vi.fn(
      () =>
        new Promise<RoundResult>((resolve) => {
          release = resolve;
        }),
    );
    const { result, unmount } = renderHook(() =>
      useTraceWait(true, () => round, "key", LAST_RESORT),
    );

    await flush();
    unmount();
    release?.({ kind: "found", found: FOUND });
    await flush();

    expect(result.current).toEqual({ kind: "waiting" });
    expect(vi.getTimerCount()).toBe(0);
  });
});

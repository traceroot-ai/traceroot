"use client";

import { useEffect, useRef, useState } from "react";
import type { FirstTrace } from "@/lib/first-trace";

/**
 * How long between rounds of looking.
 *
 * A round costs at least one trace read, and trace reads come out of the same
 * per-workspace budget as the dashboard's. Ten seconds keeps a whole wait well
 * inside the smallest plan's allowance while still reacting within a few
 * seconds of a trace landing — and against the minutes it takes to install a
 * package, instrument a service and run it, a few seconds either way is not
 * what either page is really waiting on.
 *
 * One number for both pages on purpose. The device page's round is the more
 * expensive of the two, so a value that is safe there is safe for a page
 * watching a single project — and two constants would drift.
 */
export const POLL_INTERVAL_MS = 10_000;

/**
 * How long a tab will wait in total.
 *
 * Long enough to cover installing the SDK, instrumenting a service and running
 * it, and finite because a spinner with no end is the one outcome this wait
 * must never produce. When the budget runs out the tab says so.
 */
export const WAIT_BUDGET_MS = 10 * 60 * 1000;

/**
 * Where a wait stands: still watching, settled on a trace, or finished without
 * one.
 *
 * `gave-up` carries somewhere to go, because a wait that ends empty still owes
 * the person a way into the product.
 *
 * It also carries whether the reads themselves were failing. "No trace has
 * arrived" is a statement about the run, and a tab that could not read the
 * traces at all — an expired session, a proxy answering errors — is in no
 * position to make it. Absent means the reads worked and nothing came.
 */
export type TraceWait =
  | { kind: "waiting" }
  | { kind: "found"; found: FirstTrace }
  | { kind: "gave-up"; fallbackUrl: string; unreadable?: boolean };

/**
 * The state every wait begins in, as one value rather than a fresh object.
 *
 * A restart sets it again, and `useState` compares by identity: one constant is
 * what keeps the common case — a wait starting for the first time — from
 * re-rendering for a state it is already in.
 */
const WAITING: TraceWait = { kind: "waiting" };

/**
 * What one round of looking concluded.
 *
 * Every answer but `found` carries a fallback, because any round may turn out
 * to be the last one — the budget can run out on the next tick — and the page
 * that ends up with nothing still has to point somewhere. Only the round knows
 * where: it is the thing that just read the account.
 */
export type RoundResult =
  | { kind: "found"; found: FirstTrace }
  | { kind: "again"; fallbackUrl: string }
  /** `unreadable` when the round is stopping because it could not read, not
   * because it looked and found nothing. */
  | { kind: "stop"; fallbackUrl: string; unreadable?: boolean };

/**
 * One round of looking, or `null` when it noticed mid-flight that the wait had
 * been cancelled and stopped where it was.
 *
 * A round is several reads deep, so a tab that goes away part-way through one
 * would otherwise keep issuing requests on behalf of a page nobody is on. The
 * loop below ignores a late answer either way; `null` is how a round declines
 * to go and fetch one.
 */
export type WaitRound = () => Promise<RoundResult | null>;

/**
 * Starts a wait, allocating whatever state it carries between rounds.
 *
 * A factory rather than a plain round so that state — a baseline drawn on the
 * first round, a count of fruitless ones — lives in the round's own closure and
 * is therefore discarded when the wait restarts. A baseline that outlived its
 * wait would be a line drawn before the run it is meant to exclude.
 *
 * `isCancelled` is for a round to consult between its own reads. It is already
 * true by the time the loop discards a result, so checking it is an economy
 * rather than a correctness measure.
 */
export type BeginWait = (isCancelled: () => boolean) => WaitRound;

/**
 * Run a caller's round on a timer until it finds a trace, stops, or runs out of
 * budget.
 *
 * This is the half that both setup flows share: the pacing, the deadline, and
 * the guarantee that a tab can be closed at any moment without consequence. The
 * rounds themselves differ, because the two pages know different amounts about
 * where the trace will land.
 *
 * Strictly additive, in both directions. Nothing here writes, so a tab that is
 * closed — or never opened — changes nothing about the run, and whatever this
 * reports, the run's own outcome is reported where it is actually happening.
 *
 * The loop is a chain of timeouts rather than an interval, so a slow round
 * cannot overlap the next one, and `cancelled` closes over the whole chain so
 * an unmount stops it without a late state update.
 */
export function useTraceWait(
  active: boolean,
  beginWait: BeginWait,
  /** The identity whose change should abandon this wait and start a new one. */
  restartKey: string,
  /**
   * Where to send someone whose wait ends before any round could say.
   *
   * A round names the way out it found, but the first one may never answer —
   * the budget can expire with nothing read at all — and a wait that ends has
   * to point somewhere regardless. So the caller says in advance where that is.
   */
  lastResortUrl: string,
): TraceWait {
  const [wait, setWait] = useState<TraceWait>(WAITING);

  // Read through refs so a caller that rebuilds the factory, or recomputes the
  // fallback, on every render does not restart the wait — and with it the
  // baseline, which would then be drawn after the run had already started.
  // `restartKey` is what a restart should actually follow.
  const beginRef = useRef(beginWait);
  beginRef.current = beginWait;
  const lastResortRef = useRef(lastResortUrl);
  lastResortRef.current = lastResortUrl;

  useEffect(() => {
    if (!active) {
      return;
    }

    // A new cycle starts over visibly. Without this a restart — a different
    // account, a different project — would leave the previous wait's answer on
    // screen while the new one runs, pointing at a trace this wait has nothing
    // to do with.
    setWait(WAITING);

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    // Where to leave someone whose wait ends with nothing: the caller's
    // standing answer until a round gets far enough to know a better one.
    let fallbackUrl = lastResortRef.current;
    const round = beginRef.current(() => cancelled);

    /** Drop the timer the next round is waiting on, if one is pending. */
    function clearPendingRound() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    }

    function stop() {
      cancelled = true;
      clearPendingRound();
      if (expiry !== undefined) {
        clearTimeout(expiry);
        expiry = undefined;
      }
    }

    /** The wait's last word: no more rounds, no more timers. */
    function settle(outcome: TraceWait) {
      stop();
      setWait(outcome);
    }

    // The budget as a deadline on the wait itself, rather than a check made
    // between rounds. `fetch` has no timeout of its own, so a single read that
    // never resolves would otherwise hold the wait open indefinitely — and a
    // spinner with no end is the one outcome this must never produce. Expiring
    // also cancels the wait, so a round still in flight stops at its next
    // check and whatever it eventually answers is discarded.
    expiry = setTimeout(() => {
      settle({ kind: "gave-up", fallbackUrl });
    }, WAIT_BUDGET_MS);

    function schedule() {
      timer = setTimeout(() => {
        void tick();
      }, POLL_INTERVAL_MS);
    }

    // Whether a round is in flight. Only the visibility kick below can arrive
    // mid-round — the timer chain cannot, by construction — and two rounds
    // racing the same baseline is the overlap this loop is a chain of timeouts
    // rather than an interval to avoid.
    let running = false;

    async function tick(): Promise<void> {
      if (running) {
        return;
      }
      running = true;
      let result: RoundResult | null;
      try {
        result = await round();
      } catch {
        // A round absorbs its own failed reads, so a throw reaching here is a
        // defect rather than a flaky network. Coming back is still better than
        // stopping dead with no timer and no answer, and the deadline above
        // bounds the retrying either way.
        result = { kind: "again", fallbackUrl };
      } finally {
        running = false;
      }
      if (cancelled || result === null) {
        return;
      }
      if (result.kind === "found") {
        settle({ kind: "found", found: result.found });
        return;
      }
      // Every other answer carries the way out the round found, which is a
      // better one than the caller's standing answer.
      fallbackUrl = result.fallbackUrl;
      if (result.kind === "stop") {
        settle({ kind: "gave-up", fallbackUrl, unreadable: result.unreadable });
        return;
      }
      schedule();
    }

    // Hidden is this wait's normal state: the person was told to go back to
    // their terminal. A hidden tab's timers are throttled — Chrome aligns them
    // to roughly one a minute once a tab has been out of sight for five, and
    // iOS Safari can suspend them outright — so coming back starts a round at
    // once instead of waiting out whatever is left of the interval. The budget
    // is wall-clock either way, so this changes when a trace is noticed, never
    // how long the wait lasts.
    function onVisible() {
      if (cancelled || document.visibilityState !== "visible") {
        return;
      }
      // Nothing is pending while a round runs, so this clears a due timer or
      // an already-fired id; `tick` declines either way if one is in flight.
      clearPendingRound();
      void tick();
    }
    document.addEventListener("visibilitychange", onVisible);

    void tick();

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      stop();
    };
    // beginRef holds the current factory; `restartKey` is the identity a
    // restart should follow.
  }, [active, restartKey]);

  return wait;
}

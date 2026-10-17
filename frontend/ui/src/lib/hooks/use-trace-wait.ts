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
 */
export type TraceWait =
  | { kind: "waiting" }
  | { kind: "found"; found: FirstTrace }
  | { kind: "gave-up"; fallbackUrl: string };

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
  | { kind: "stop"; fallbackUrl: string };

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
): TraceWait {
  const [wait, setWait] = useState<TraceWait>({ kind: "waiting" });

  // Read through a ref so a caller that rebuilds the factory on every render
  // does not restart the wait — and with it the baseline, which would then be
  // drawn after the run had already started. `restartKey` is what a restart
  // should actually follow.
  const beginRef = useRef(beginWait);
  beginRef.current = beginWait;

  useEffect(() => {
    if (!active) {
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + WAIT_BUDGET_MS;
    const round = beginRef.current(() => cancelled);

    function schedule(fallbackUrl: string) {
      if (Date.now() + POLL_INTERVAL_MS > deadline) {
        setWait({ kind: "gave-up", fallbackUrl });
        return;
      }
      timer = setTimeout(() => {
        void tick();
      }, POLL_INTERVAL_MS);
    }

    async function tick(): Promise<void> {
      const result = await round();
      if (cancelled || result === null) {
        return;
      }
      if (result.kind === "found") {
        setWait({ kind: "found", found: result.found });
        return;
      }
      if (result.kind === "stop") {
        setWait({ kind: "gave-up", fallbackUrl: result.fallbackUrl });
        return;
      }
      schedule(result.fallbackUrl);
    }

    void tick();

    return () => {
      cancelled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
    // beginRef holds the current factory; `restartKey` is the identity a
    // restart should follow.
  }, [active, restartKey]);

  return wait;
}

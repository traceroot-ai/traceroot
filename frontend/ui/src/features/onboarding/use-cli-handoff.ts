"use client";

import { useEffect, useState } from "react";
import { createCliHandoff, type CliHandoff } from "@/lib/api/cli-handoff";

/**
 * How far ahead of expiry the code is replaced.
 *
 * Short on purpose, and the reason is the mint's one-live-handoff rule: minting
 * a replacement invalidates the code already on screen, which someone may have
 * copied a moment ago. A long lead would make that window large; this one keeps
 * it to the last half-minute of a code's life, against the ten fresh minutes
 * the replacement buys a tab that is still open.
 *
 * A code redeemed in that half-minute is not a dead end either way: `setup`
 * reports one line and falls through to the device flow, which is the browser
 * page the handoff exists to skip rather than a failure.
 */
export const HANDOFF_REFRESH_LEAD_MS = 30_000;

/**
 * The floor on the gap between mints.
 *
 * Only reached if the route ever answers with a lifetime shorter than the lead
 * above. Without it a short `expiresIn` would schedule the next mint
 * immediately and turn the refresh into a loop against the endpoint.
 */
export const HANDOFF_MIN_REFRESH_MS = 30_000;

/**
 * Hold a live handoff code for the project this run just created.
 *
 * Mints once, as soon as there is a project — which is the moment the hand-back
 * step first renders — and then replaces the code shortly before it expires for
 * as long as the tab is open. The step re-renders on every tick of the trace
 * wait anyway, so this is a timer and a state field rather than new machinery.
 *
 * Failure is silent by design. `null` is what the caller gets before the first
 * mint lands, if the mint fails, and once a code has expired with no
 * replacement — and `setupCommand` renders the command without `--handoff` in
 * exactly those cases. That command is the one this page printed before
 * handoffs existed: it works, by way of a second browser page. There is no
 * degraded state to report and nothing the user could do about it, so nothing
 * is said.
 *
 * A failed mint is not retried on its own timer. The command on screen is
 * already correct, and a page that answers an unreachable endpoint by asking it
 * again every few seconds is worse than one that quietly prints the working
 * line. A failed *replacement* is gentler: the code in hand stays on screen
 * until its own expiry and is dropped then.
 *
 * Nothing here writes anything the account keeps — an unredeemed handoff
 * expires on its own — so a tab closed at any moment costs nothing. The effect
 * cancels in its cleanup, so no mint is issued, and no state is set, after an
 * unmount or a change of project.
 */
export function useCliHandoff(projectId: string | null): string | null {
  const [code, setCode] = useState<string | null>(null);

  useEffect(() => {
    if (projectId === null) {
      setCode(null);
      return;
    }
    // Captured as a `string` const after the guard, rather than used directly:
    // `mint` below is a hoisted function declaration, which TypeScript analyses
    // without the narrowing this line bakes into the type.
    const watched = projectId;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // When the code currently on screen stops being redeemable. Held here
    // rather than read back out of state so that a failed replacement can tell
    // "there is still a usable code" from "there is nothing left to show"
    // without the effect depending on its own output.
    let expiresAtMs = 0;

    function schedule(delayMs: number, run: () => void) {
      timer = setTimeout(run, Math.max(delayMs, 0));
    }

    async function mint(): Promise<void> {
      let minted: CliHandoff | null = null;
      try {
        minted = await createCliHandoff(watched);
      } catch {
        minted = null;
      }
      if (cancelled) {
        return;
      }

      if (minted) {
        // `expiresIn` rather than `expiresAt`: a relative lifetime cannot be
        // thrown off by a clock that disagrees with the server's, and the only
        // thing this needs the value for is when to come back.
        const lifetimeMs = Number(minted.expiresIn) * 1000;
        const usableLifetime = Number.isFinite(lifetimeMs) && lifetimeMs > 0 ? lifetimeMs : 0;
        expiresAtMs = usableLifetime > 0 ? Date.now() + usableLifetime : 0;
        setCode(minted.code);
        if (usableLifetime > 0) {
          schedule(
            Math.max(usableLifetime - HANDOFF_REFRESH_LEAD_MS, HANDOFF_MIN_REFRESH_MS),
            () => void mint(),
          );
        }
        // A lifetime the route did not state is one this page cannot plan
        // around, so it schedules nothing and shows the code it was given. It
        // expires when it expires, and the CLI's own fallback covers that.
        return;
      }

      const remainingMs = expiresAtMs - Date.now();
      if (remainingMs > 0) {
        // The replacement failed but the code on screen has not expired yet.
        // Keep it — it is still redeemable — and drop it the moment it is not.
        schedule(remainingMs, () => {
          if (!cancelled) {
            setCode(null);
          }
        });
        return;
      }
      setCode(null);
    }

    void mint();

    return () => {
      cancelled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [projectId]);

  return code;
}

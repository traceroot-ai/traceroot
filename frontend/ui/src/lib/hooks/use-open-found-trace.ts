"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { traceUrl } from "@/lib/first-trace";
import type { TraceWait } from "@/lib/hooks/use-trace-wait";

/**
 * Open the trace a wait settled on, the moment it settles.
 *
 * Both ends of a first run finish the same way — the device approval and the
 * onboarding hand-back — and advancing on its own is the whole point of either:
 * the person was told to go back to their terminal, so nobody is here to click
 * anything when the trace lands. The trace is also the thing the whole flow was
 * for, so arriving at it is the completion rather than an offer to complete.
 *
 * One hook rather than the same effect on both pages, for the same reason one
 * component renders the line they both show: the two flows make the same
 * statement about the same wait, and the sentence half of that pair had already
 * drifted within a day of being written twice (see components/first-trace-line).
 */
export function useOpenFoundTrace(wait: TraceWait): void {
  const router = useRouter();
  useEffect(() => {
    if (wait.kind === "found") {
      router.push(traceUrl(wait.found));
    }
  }, [wait, router]);
}

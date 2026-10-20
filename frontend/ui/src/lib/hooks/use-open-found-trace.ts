"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { traceUrl } from "@/lib/first-trace";
import type { TraceWait } from "@/lib/hooks/use-trace-wait";

/**
 * Open the trace a wait settled on, the moment it settles.
 *
 * Advancing on its own is the whole point: the person was told to go back to
 * their terminal, so nobody is here to click anything when the trace lands. The
 * trace is also the thing the whole flow was for, so arriving at it is the
 * completion rather than an offer to complete.
 */
export function useOpenFoundTrace(wait: TraceWait): void {
  const router = useRouter();
  useEffect(() => {
    if (wait.kind === "found") {
      router.push(traceUrl(wait.found));
    }
  }, [wait, router]);
}

"use client";

import Link from "next/link";
import { Check, Loader2 } from "lucide-react";
import { traceUrl } from "@/lib/first-trace";
import type { TraceWait } from "@/lib/hooks/use-trace-wait";

interface FirstTraceLineProps {
  /** How the watch for the first trace is going. */
  wait: TraceWait;
}

/**
 * What the end of a first run says about the trace it is watching for.
 *
 * Without this the last step of signing up gives no sign that anything is
 * listening: a person runs the command they were just handed and has no reason
 * to believe the page will react, so they either sit on it or leave it. One
 * line is enough to say that it will.
 *
 * The page opens the trace when it lands, so the arrival state is what the
 * person sees for the moment before the page moves. It still carries the link,
 * because navigation can be slow or refused and a statement with no way forward
 * would leave them stranded on good news.
 *
 * Every state is a statement and a way forward, and none of them disables
 * anything around it. The run is happening in a terminal and will finish
 * whatever this line says — including when it says nothing arrived.
 */
export function FirstTraceLine({ wait }: FirstTraceLineProps) {
  return (
    // One live region, present in every state rather than mounted along with
    // its text: a region that appears at the same moment as its content is not
    // announced, and reporting a change nobody is watching for is this line's
    // entire job — the person was told to go back to their terminal.
    <div role="status" aria-live="polite">
      <Line wait={wait} />
    </div>
  );
}

function Line({ wait }: FirstTraceLineProps) {
  if (wait.kind === "waiting") {
    return (
      <p className="flex items-center justify-center gap-2 text-[11px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Waiting for your first trace. This page updates when it arrives.
      </p>
    );
  }

  if (wait.kind === "found") {
    return (
      <p className="flex items-center justify-center gap-2 text-[11px] text-muted-foreground">
        <Check className="h-3.5 w-3.5 text-green-600" />
        <span>Your first trace arrived. Opening it…</span>
        <Link href={traceUrl(wait.found)} className="font-medium underline hover:text-foreground">
          View it
        </Link>
      </p>
    );
  }

  if (wait.unreadable) {
    // The reads were failing, so "no trace arrived" would be a claim about the
    // run that this tab cannot make. The way out is the same page either way,
    // and it is also where an expired session gets asked to sign in again.
    return (
      <p className="text-center text-[11px] text-muted-foreground">
        We could not read your traces from this tab.{" "}
        <Link href={wait.fallbackUrl} className="underline hover:text-foreground">
          Open your traces
        </Link>{" "}
        to see what has arrived.
      </p>
    );
  }

  // Out of budget. Said plainly rather than left spinning, and pointed at the
  // page that will show the trace whenever it does turn up — the setup itself
  // is still running wherever the command was run.
  return (
    <p className="text-center text-[11px] text-muted-foreground">
      Still no trace.{" "}
      <Link href={wait.fallbackUrl} className="underline hover:text-foreground">
        Open your traces
      </Link>{" "}
      once your application has sent one.
    </p>
  );
}

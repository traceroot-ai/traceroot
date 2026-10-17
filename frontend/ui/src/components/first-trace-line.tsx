"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Check, Loader2 } from "lucide-react";
import { traceUrl } from "@/lib/first-trace";
import type { TraceWait } from "@/lib/hooks/use-trace-wait";

/** The wait once it has ended with no trace. */
type EmptyWait = Extract<TraceWait, { kind: "gave-up" }>;

interface FirstTraceLineProps {
  /** How the watch for the first trace is going. */
  wait: TraceWait;
  /**
   * What to say when the wait ends with nothing, for a caller whose ending is
   * genuinely a different statement. The device page's is: that flow has a
   * terminal holding the authoritative result, so the empty ending there leads
   * with the terminal rather than with the trace. Omitted, the shared line is
   * used.
   */
  gaveUp?: (wait: EmptyWait) => ReactNode;
  /**
   * The waiting line's second sentence, saying what this page does once the
   * trace lands. Omitted, it is the hand-back's "This page updates when it
   * arrives."; the device page passes its own.
   */
  arrival?: string;
}

/**
 * What the end of a first run says about the trace it is watching for.
 *
 * Without this the last step of signing up gives no sign that anything is
 * listening: a person runs the command they were just handed and has no reason
 * to believe the page will react, so they either sit on it or leave it. One
 * line is enough to say that it will.
 *
 * One component for both pages that wait — the onboarding hand-back and the
 * device approval — rather than the same lines written twice. Written twice
 * they had already drifted within a day, `...` against `…`. What each page
 * still says for itself is passed in: the device page's empty ending, and its
 * waiting line's "opens it" where the hand-back's says "updates". Both pages
 * open the trace when it lands, so the arrival state is what the person sees
 * for the moment before the page moves. It still carries the link, because
 * navigation can be slow or refused and a statement with no way forward would
 * leave them stranded on good news.
 *
 * Every state is a statement and a way forward, and none of them disables
 * anything around it. The run is happening in a terminal and will finish
 * whatever this line says — including when it says nothing arrived.
 */
export function FirstTraceLine({ wait, gaveUp, arrival }: FirstTraceLineProps) {
  return (
    // One live region, present in every state rather than mounted along with
    // its text: a region that appears at the same moment as its content is not
    // announced, and reporting a change nobody is watching for is this line's
    // entire job — the person was told to go back to their terminal.
    <div role="status" aria-live="polite">
      <Line wait={wait} gaveUp={gaveUp} arrival={arrival} />
    </div>
  );
}

function Line({
  wait,
  gaveUp,
  arrival = "This page updates when it arrives.",
}: FirstTraceLineProps) {
  if (wait.kind === "waiting") {
    return (
      <p className="flex items-center justify-center gap-2 text-[11px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        {`Waiting for your first trace. ${arrival}`}
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

  if (gaveUp) {
    return <>{gaveUp(wait)}</>;
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

"use client";

import {
  LOOP_RUN_IN_PROGRESS,
  LOOP_RUN_PAUSED,
  LOOP_RUN_PLAN_BLOCKED,
} from "@traceroot/core/loops/pure";
import { Button } from "@/components/ui/button";
import { useRunLoop } from "../hooks/use-loops";

interface RunLoopProps {
  projectId: string;
  loopId: string;
  /** A run is queued or running: a Loop never has two. */
  active: boolean;
  /** The workspace's plan has no Loop runs left: a queued run would only be skipped. */
  planBlocked?: boolean;
  /** Paused by a person or by the system: it runs again once resumed. */
  paused?: boolean;
}

/**
 * Run now. Queues a manual run; a worker picks it up on its next tick, so until
 * one does the run stays Queued (the runs table shows it, and looks again every 10 s).
 * Disabled, with the reason, while a run is active, the Loop is paused, or the
 * plan's runs are used up.
 */
export function RunLoop({ projectId, loopId, active, planBlocked, paused }: RunLoopProps) {
  const run = useRunLoop(projectId, loopId);
  const busy = active || run.isPending;
  // The same order the run route checks: an active run, then a pause, then the plan.
  const reason = active
    ? LOOP_RUN_IN_PROGRESS
    : paused
      ? LOOP_RUN_PAUSED
      : planBlocked
        ? LOOP_RUN_PLAN_BLOCKED
        : null;
  return (
    <div className="flex items-center gap-2" aria-live="polite">
      {run.isError && (
        <span role="alert" className="text-[12px] text-destructive">
          {run.error.message}
        </span>
      )}
      {/* A disabled button shows no tooltip in every browser: the wrapper carries it. */}
      <span title={reason ?? undefined} className="inline-flex">
        <Button size="sm" disabled={busy || reason !== null} onClick={() => run.mutate()}>
          {busy ? "Run queued" : "Run now"}
        </Button>
      </span>
    </div>
  );
}

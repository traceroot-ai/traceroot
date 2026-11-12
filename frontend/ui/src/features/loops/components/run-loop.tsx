"use client";

import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRunLoop } from "../hooks/use-loops";

interface RunLoopProps {
  projectId: string;
  loopId: string;
  /** A run is queued or running: a Loop never has two. */
  active: boolean;
}

/**
 * Run now. Queues a manual run; a worker picks it up on its next tick, so until
 * one does the run stays Queued (the Runs tab shows it, and looks again every 10 s).
 */
export function RunLoop({ projectId, loopId, active }: RunLoopProps) {
  const run = useRunLoop(projectId, loopId);
  const busy = active || run.isPending;
  return (
    <div className="flex items-center gap-2" aria-live="polite">
      {run.isError && (
        <span role="alert" className="text-[12px] text-destructive">
          {run.error.message}
        </span>
      )}
      <Button
        size="sm"
        className="h-7 gap-1 text-[12px]"
        disabled={busy}
        onClick={() => run.mutate()}
        title={active ? "This Loop already has a run in progress" : undefined}
      >
        <Play className="h-3.5 w-3.5" />
        {busy ? "Run queued" : "Run now"}
      </Button>
    </div>
  );
}

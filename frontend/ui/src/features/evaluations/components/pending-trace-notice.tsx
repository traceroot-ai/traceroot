"use client";

import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** What a result's reported trace shows while its telemetry is still ingesting (its fetch
 *  fails until it lands), with a retry. */
export function PendingTraceNotice({
  traceId,
  isFetching,
  onRetry,
}: {
  traceId: string;
  isFetching: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-[12px]">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden />
      <p className="text-[13px] font-medium">Trace is still being ingested</p>
      <p className="max-w-[360px] leading-relaxed text-muted-foreground">
        This result reported a trace (<span className="font-mono">{traceId.slice(0, 12)}…</span>),
        but its telemetry hasn&apos;t finished ingesting yet. It will appear here once it lands.
      </p>
      <Button
        variant="outline"
        className="h-7 gap-1.5 text-[12px]"
        disabled={isFetching}
        onClick={onRetry}
      >
        <Loader2 className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} aria-hidden />
        Retry
      </Button>
    </div>
  );
}

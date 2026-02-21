"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, ExternalLink, Layers, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IOSection } from "@/components/ui/json-view";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { useSession } from "@/features/traces/hooks";
import { formatDate, formatDuration, cn } from "@/lib/utils";
import type { SessionTraceItem } from "@/types/api";

function formatTokens(count: number | null): string {
  if (count === null || count === undefined) return "-";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

function MetaBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-0.5 text-[12px] text-muted-foreground">
      {children}
    </span>
  );
}

function TraceRow({
  trace,
  index,
  projectId,
}: {
  trace: SessionTraceItem;
  index: number;
  projectId: string;
}) {
  return (
    <div className="rounded-md border border-border">
      {/* Header: trace link + metadata */}
      <div className="flex items-center justify-between border-b border-border/50 bg-muted/30 px-4 py-2">
        <div className="flex items-center gap-2 text-[12px]">
          <span className="text-muted-foreground">#{index + 1}</span>
          <Link
            href={`/projects/${projectId}/traces/${trace.trace_id}`}
            className="font-medium text-foreground hover:underline"
          >
            {trace.name}
            <span className="ml-1 font-mono text-[11px] text-muted-foreground">
              {trace.trace_id.slice(0, 8)}...
            </span>
            <ExternalLink className="ml-1 inline h-3 w-3 text-muted-foreground" />
          </Link>
        </div>
        <div className="flex items-center gap-1.5 text-[11px]">
          <span className="text-muted-foreground">{formatDate(trace.trace_start_time)}</span>
          {trace.duration_ms !== null && (
            <span className="text-muted-foreground">· {formatDuration(trace.duration_ms)}</span>
          )}
          {trace.user_id && (
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              · <User className="h-2.5 w-2.5" /> {trace.user_id}
            </span>
          )}
          <span
            className={cn(
              "ml-1 inline-flex items-center rounded px-1.5 py-0.5 font-medium",
              trace.status === "error"
                ? "bg-destructive/10 text-destructive"
                : "text-muted-foreground",
            )}
          >
            {trace.status}
          </span>
        </div>
      </div>

      {/* Content: Input/Output */}
      <div className="flex flex-col gap-3 overflow-hidden px-4 py-3">
        <IOSection label="Input" value={trace.input} />
        <IOSection label="Output" value={trace.output} />
        {!trace.input && !trace.output && (
          <div className="py-1 text-[12px] text-muted-foreground">
            This trace has no input or output.
          </div>
        )}
      </div>
    </div>
  );
}

export default function SessionDetailPage() {
  const params = useParams();
  const projectId = params.projectId as string;
  const sessionId = params.sessionId as string;

  const { data, isLoading, error } = useSession(projectId, sessionId);

  return (
    <div className="relative flex h-full text-[13px]">
      <ProjectBreadcrumb projectId={projectId} />

      <div className="flex flex-1 flex-col overflow-auto">
        {/* Header */}
        <div className="border-b border-border bg-background px-4 py-3">
          <div className="flex items-center gap-3">
            <Link href={`/projects/${projectId}/sessions`}>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </Link>
            <Layers className="h-4 w-4 text-muted-foreground" />
            <span className="text-[14px] font-semibold">{sessionId}</span>
          </div>
        </div>

        {/* Sticky session stats bar */}
        {data && (
          <div className="sticky top-0 z-40 flex flex-wrap gap-2 border-b border-border bg-background p-4">
            {data.user_ids.length > 0 && (
              <MetaBadge>
                <User className="h-3 w-3" />
                {data.user_ids.join(", ")}
              </MetaBadge>
            )}
            <MetaBadge>Total traces: {data.trace_count}</MetaBadge>
            {data.duration_ms !== null && (
              <MetaBadge>Duration: {formatDuration(data.duration_ms)}</MetaBadge>
            )}
            {(data.total_input_tokens !== null || data.total_output_tokens !== null) && (
              <MetaBadge>
                Tokens: {formatTokens(data.total_input_tokens)} in /{" "}
                {formatTokens(data.total_output_tokens)} out
              </MetaBadge>
            )}
          </div>
        )}

        {/* Trace list */}
        <div className="flex-1 overflow-auto p-4">
          {isLoading ? (
            <div className="flex h-64 items-center justify-center">
              <p className="text-[13px] text-muted-foreground">Loading session...</p>
            </div>
          ) : error ? (
            <div className="flex h-64 flex-col items-center justify-center gap-3">
              <p className="text-[13px] text-destructive">Error loading session</p>
              <p className="text-[12px] text-muted-foreground">
                Make sure the API server is running.
              </p>
            </div>
          ) : !data ? (
            <div className="flex h-64 flex-col items-center justify-center gap-3">
              <Layers className="h-10 w-10 text-muted-foreground" />
              <p className="text-[13px] text-muted-foreground">Session not found</p>
            </div>
          ) : data.traces.length === 0 ? (
            <div className="flex h-64 flex-col items-center justify-center gap-3">
              <Layers className="h-10 w-10 text-muted-foreground" />
              <p className="text-[13px] text-muted-foreground">No traces in this session</p>
            </div>
          ) : (
            <div className="space-y-3">
              {data.traces.map((trace: SessionTraceItem, index: number) => (
                <TraceRow key={trace.trace_id} trace={trace} index={index} projectId={projectId} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

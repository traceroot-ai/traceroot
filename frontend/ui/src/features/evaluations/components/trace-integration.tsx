"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Database, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getTrace } from "@/lib/api/traces";
import { SpanKindIcon } from "@/features/traces";
import { FormCard } from "@/features/offline-eval/components";
import type { Span } from "@/types/api";
import { useDatasets, useSaveTestCase, useTraceEvaluationResults } from "../hooks";

/** Root = the span with no parent (the evaluation-item / application root). */
function rootSpan(spans: Span[]): Span | undefined {
  return spans.find((s) => !s.parent_span_id) ?? spans[0];
}

/**
 * Save a real trace/span as a server-backed test case. Opened from the existing
 * trace viewer's span header. For a child span it saves a component-level case;
 * for the trace root (no spanId) it fetches the trace and saves the application
 * scope. Never treats the produced output as the expected answer, and surfaces
 * duplicates instead of silently creating a second case.
 */
export function SaveTestCaseDrawer({
  projectId,
  traceId,
  spanId,
  open,
  onOpenChange,
}: {
  projectId: string;
  traceId: string | null;
  /** Undefined = the trace root / application scope. */
  spanId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: datasetsData } = useDatasets(projectId);
  const datasets = datasetsData?.data ?? [];

  const { data: trace } = useQuery({
    queryKey: ["trace", projectId, traceId],
    queryFn: () => getTrace(projectId, traceId as string, ""),
    enabled: open && !!traceId,
  });

  const span = React.useMemo(() => {
    if (!trace) return undefined;
    return spanId ? trace.spans.find((s) => s.span_id === spanId) : rootSpan(trace.spans);
  }, [trace, spanId]);
  const isRoot = !spanId;

  const [datasetId, setDatasetId] = React.useState("");
  const [setExpected, setSetExpected] = React.useState(false);
  const [expected, setExpectedValue] = React.useState("");
  const [duplicateIn, setDuplicateIn] = React.useState<string | null>(null);
  const [feedback, setFeedback] = React.useState<{
    tone: "error" | "success";
    text: string;
  } | null>(null);

  React.useEffect(() => {
    if (open) {
      setDatasetId((prev) => prev || (datasets[0]?.id ?? ""));
      setSetExpected(false);
      setExpectedValue("");
      setDuplicateIn(null);
      setFeedback(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const save = useSaveTestCase(projectId, datasetId);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onOpenChange(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onOpenChange]);

  if (!open || !traceId) return null;

  const handleSave = () => {
    if (!span || !datasetId) return;
    save.mutate(
      {
        input: span.input ?? "",
        // The observed output is never auto-treated as the expected answer.
        expected: setExpected && expected.trim() ? expected.trim() : null,
        recorded_output: span.output ?? null,
        review: "needs_review",
        capture_reason: span.status === "ERROR" ? "error" : "manual",
        source_trace_id: traceId,
        source_span_id: span.span_id,
        source_span_name: span.name,
        source_span_kind: isRoot ? "trace" : span.span_kind,
      },
      {
        onSuccess: (res) => {
          if (res.duplicate) {
            setDuplicateIn(datasetId);
            return;
          }
          setFeedback({ tone: "success", text: "Saved — published as a new dataset version." });
          setTimeout(() => onOpenChange(false), 700);
        },
        onError: () => setFeedback({ tone: "error", text: "Could not save test case." }),
      },
    );
  };

  return (
    <div className="animate-slide-in-right fixed inset-y-0 right-0 z-50 flex w-[560px] max-w-[96vw] flex-col border-l border-border bg-background text-[12px] shadow-xl">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-[13px] font-semibold">Save as test case</h2>
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          aria-label="Close"
          className="rounded-sm text-muted-foreground opacity-70 hover:opacity-100"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 py-3">
        <FormCard label="Dataset">
          <Select value={datasetId} onValueChange={setDatasetId}>
            <SelectTrigger className="h-7 text-[13px]">
              <SelectValue placeholder={datasets.length ? "Select dataset" : "No datasets yet"} />
            </SelectTrigger>
            <SelectContent>
              {datasets.map((d) => (
                <SelectItem key={d.id} value={d.id} className="text-[12px]">
                  {d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {duplicateIn && (
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              This span is already a test case in this dataset.{" "}
              <Link
                href={`/projects/${projectId}/datasets/${duplicateIn}`}
                className="font-medium text-foreground underline underline-offset-2"
              >
                Open existing test case
              </Link>
            </p>
          )}
        </FormCard>

        <FormCard label={isRoot ? "Application (trace root)" : "Selected span"}>
          {span ? (
            <div className="flex items-center gap-2">
              <SpanKindIcon kind={isRoot ? "AGENT" : span.span_kind} inTree />
              <span className="text-[13px] font-medium">{span.name}</span>
              <span className="text-[11px] text-muted-foreground">
                {isRoot ? "workflow-level case" : "component-level case"}
              </span>
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">Loading trace…</p>
          )}
        </FormCard>

        <div>
          <p className="mb-1 text-[11px] text-muted-foreground">Input</p>
          <div className="max-h-40 overflow-auto rounded border border-border bg-muted/20 px-2.5 py-2 font-mono text-[11px] leading-relaxed">
            {span?.input || <span className="text-muted-foreground">—</span>}
          </div>
        </div>

        <div>
          <p className="mb-1 text-[11px] text-muted-foreground">
            Recorded output{" "}
            <span className="font-normal">— what happened, kept separate from expected</span>
          </p>
          <div className="max-h-40 overflow-auto rounded border border-border bg-muted/20 px-2.5 py-2 font-mono text-[11px] leading-relaxed">
            {span?.output || <span className="text-muted-foreground">—</span>}
          </div>
        </div>

        <FormCard label="Expected outcome">
          <label className="flex cursor-pointer items-center gap-2 text-[12px]">
            <input
              type="checkbox"
              checked={setExpected}
              onChange={(e) => setSetExpected(e.target.checked)}
              className="h-3.5 w-3.5 accent-foreground"
            />
            Set an expected outcome (optional)
          </label>
          {setExpected && (
            <Input
              value={expected}
              onChange={(e) => setExpectedValue(e.target.value)}
              placeholder="Expected outcome"
              className="mt-2 h-7 text-[12px]"
            />
          )}
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            The recorded output is never used as the expected answer automatically.
          </p>
        </FormCard>

        <p className="text-[11px] text-muted-foreground">
          This case will start as <span className="font-medium text-foreground">Needs review</span>{" "}
          and publishes a new dataset version.
        </p>
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-3">
        {feedback && (
          <span
            className={
              feedback.tone === "error"
                ? "mr-auto text-[11px] text-destructive"
                : "mr-auto text-[11px] text-emerald-600 dark:text-emerald-400"
            }
          >
            {feedback.text}
          </span>
        )}
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-[12px]"
          onClick={() => onOpenChange(false)}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          className="h-7 text-[12px]"
          onClick={handleSave}
          disabled={!span || !datasetId || save.isPending}
        >
          {save.isPending ? "Saving…" : "Save to dataset"}
        </Button>
      </div>
    </div>
  );
}

/**
 * "Evaluation" chip for a trace that produced evaluation results — the trace →
 * evaluation-run link, surfaced in the trace viewer (detector-findings pattern).
 */
export function TraceEvaluationChip({
  projectId,
  traceId,
}: {
  projectId: string;
  traceId: string;
}) {
  const { data } = useTraceEvaluationResults(projectId, traceId);
  const results = data?.data ?? [];
  if (results.length === 0) return null;
  const run = results[0].run;
  return (
    <Link
      href={`/projects/${projectId}/evaluations/${run.id}`}
      className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2.5 py-1 text-xs transition-colors hover:bg-muted"
      title="This trace was produced by an evaluation run"
    >
      <Database className="h-3 w-3 text-muted-foreground" aria-hidden />
      <span className="text-muted-foreground">Evaluation:</span>
      <span className="font-medium">{run.evaluation.name}</span>
      <span className="text-muted-foreground">
        Run #{run.runNumber} · {run.candidateVersion}
      </span>
    </Link>
  );
}

"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ArrowUpRight, Database, Info, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { CopyButton } from "@/components/ui/copy-button";
import { cn } from "@/lib/utils";
import { getTrace } from "@/lib/api/traces";
import { SpanKindIcon, useSpanIO } from "@/features/traces";
import {
  FormCard,
  EditableValueBlock,
  LineNumberedTextarea,
  Timestamp,
} from "@/features/offline-eval/components";
import { tokenizeCode } from "@/features/offline-eval/components/syntax";
import { useProject } from "@/features/projects/hooks";
import {
  CAPTURE_REASON_LABEL,
  SPAN_KIND_LABEL,
  type CaptureReason,
} from "@/features/offline-eval/types";
import type { Span } from "@/types/api";
import {
  useDatasets,
  useCreateDataset,
  useTraceEvaluationResults,
  useTraceTestCases,
} from "../hooks";

/** Sentinel dataset-select value for "create a new dataset". */
const NEW_DATASET = "__new__";

/** How the optional expected outcome is set for a captured case. */
type ExpectedMode = "none" | "recorded" | "corrected";

/** Root = the span with no parent (the application / evaluation-item root). */
function rootSpan(spans: Span[]): Span | undefined {
  return spans.find((s) => !s.parent_span_id) ?? spans[0];
}

/**
 * Normalise a captured JSON blob (2-space indent); leave non-JSON text alone.
 * The field's own `seedJson` preference decides the final shape it opens in —
 * this just guarantees the seed is valid, canonical JSON when it is JSON.
 */
function prettyJson(raw: string | null | undefined): string {
  if (!raw) return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** One short line explaining what a case sourced from this span actually tests. */
function boundaryHint(displayKind: string, spanName: string): string {
  const name = spanName.toLowerCase();
  if (displayKind === "trace" || displayKind === "AGENT")
    return "This tests the application from this input.";
  if (displayKind === "LLM") return "This tests this model or prompt step.";
  if (displayKind === "TOOL")
    return "This tests the tool using these arguments. To test whether the agent selected the correct tool, choose its parent agent or LLM span.";
  if (/retriev|search|recall|policy|vector|embed/.test(name))
    return "This tests retrieval from this query.";
  return "This tests this step from its input.";
}

/**
 * "Save as test case" — a faithful port of the approved mock drawer, wired to the
 * server. Opened from the existing trace viewer's span header. Self-contained: it
 * fetches the trace, walks its spans (up/down), lets you pick or create a
 * dataset, and persists via the server (which publishes a new dataset version).
 * The span's input becomes the proposed test input; its output is shown read-only
 * ("Recorded output") and is never treated as the expected answer.
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
  /** Initial span; undefined = the trace root / application scope. */
  spanId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const { data: datasetsData } = useDatasets(projectId, { limit: 200 });
  const datasets = datasetsData?.data ?? [];

  const { data: trace } = useQuery({
    queryKey: ["trace", projectId, traceId],
    queryFn: () => getTrace(projectId, traceId as string, ""),
    enabled: open && !!traceId,
  });

  const [datasetId, setDatasetId] = React.useState("");
  const [newDatasetName, setNewDatasetName] = React.useState("");
  const [selectedSpanId, setSelectedSpanId] = React.useState<string | undefined>(spanId);
  const [input, setInput] = React.useState("");
  const [metadata, setMetadata] = React.useState("");
  const [attachSource, setAttachSource] = React.useState(true);
  const [expectedMode, setExpectedMode] = React.useState<ExpectedMode>("none");
  const [correctedExpected, setCorrectedExpected] = React.useState("");
  const [duplicate, setDuplicate] = React.useState<{ datasetId: string } | null>(null);
  const [feedback, setFeedback] = React.useState<{
    tone: "error" | "success";
    text: string;
  } | null>(null);

  // Reset the dataset choice and toggles only when the panel opens, so the
  // selected dataset persists while walking between spans with up/down.
  React.useEffect(() => {
    if (open) {
      setDatasetId("");
      setNewDatasetName("");
      setSelectedSpanId(spanId);
      setAttachSource(true);
      setExpectedMode("none");
      setCorrectedExpected("");
      setDuplicate(null);
      setFeedback(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const spans = React.useMemo(() => trace?.spans ?? [], [trace]);
  const root = trace ? rootSpan(spans) : undefined;
  const span = React.useMemo(() => {
    if (!trace) return undefined;
    return selectedSpanId ? spans.find((s) => s.span_id === selectedSpanId) : root;
  }, [trace, selectedSpanId, spans, root]);
  const isRoot = !!span && !span.parent_span_id;

  // The trace-detail response OMITS span input/output/metadata — they are fetched
  // per span on demand (getSpanIO), so read them from that hook, not the span.
  const { data: spanIO } = useSpanIO(projectId, traceId ?? "", span?.span_id ?? null);

  // Input / recorded output / metadata follow the fetched span I/O (incl. nav).
  React.useEffect(() => {
    if (open && spanIO) {
      setInput(spanIO.input ?? "");
      setMetadata(prettyJson(spanIO.metadata));
    }
  }, [open, spanIO]);

  // Reset the duplicate note whenever the selected span changes.
  React.useEffect(() => {
    if (open) setDuplicate(null);
  }, [open, span?.span_id]);

  // Non-modal: Escape closes this panel without touching the trace behind it.
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

  const createDataset = useCreateDataset(projectId);
  const save = useMutation({
    mutationFn: async (vars: { datasetId: string; body: Record<string, unknown> }) => {
      const res = await fetch(`/api/projects/${projectId}/datasets/${vars.datasetId}/test-cases`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vars.body),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error(detail?.error ?? `Save failed: ${res.status}`);
      }
      return res.json() as Promise<{ duplicate: boolean; testCaseId?: string; versionId?: string }>;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["datasets"] });
      // Refresh the span→dataset chips so the just-saved span is marked at once.
      void qc.invalidateQueries({ queryKey: ["evaluations", "trace-test-cases"] });
    },
  });

  if (!open || !traceId) return null;

  const creatingNew = datasetId === NEW_DATASET;
  const dataset = datasets.find((item) => item.id === datasetId);
  const displayKind = isRoot ? "trace" : (span?.span_kind ?? "SPAN");
  const recordedOutput = spanIO?.output ?? "";
  const currentIndex = span ? spans.findIndex((s) => s.span_id === span.span_id) : -1;
  const canNavigateUp = currentIndex > 0;
  const canNavigateDown = currentIndex >= 0 && currentIndex < spans.length - 1;

  const inferredReason: CaptureReason =
    span?.status === "ERROR" ? (displayKind === "TOOL" ? "failed_tool" : "error") : "manual";

  const canSave =
    !!span && (creatingNew ? newDatasetName.trim() !== "" : datasetId !== "") && !save.isPending;

  const navigate = (dir: "up" | "down") => {
    if (currentIndex < 0) return;
    const next = dir === "up" ? currentIndex - 1 : currentIndex + 1;
    if (next >= 0 && next < spans.length) setSelectedSpanId(spans[next].span_id);
  };

  const handleSave = async () => {
    if (!span || !canSave) return;
    setFeedback(null);
    try {
      let dsId = datasetId;
      if (creatingNew) {
        const created = await createDataset.mutateAsync({ name: newDatasetName.trim() });
        dsId = created.dataset.id;
        setDatasetId(dsId);
      }
      let metadataObj: Record<string, unknown> | null = null;
      try {
        const parsed = metadata.trim() ? JSON.parse(metadata) : null;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadataObj = parsed;
      } catch {
        /* non-JSON metadata → not persisted */
      }
      const expected =
        expectedMode === "recorded"
          ? recordedOutput || null
          : expectedMode === "corrected"
            ? correctedExpected.trim() || null
            : null;
      const res = await save.mutateAsync({
        datasetId: dsId,
        body: {
          input,
          expected,
          recorded_output: recordedOutput || null,
          metadata: metadataObj,
          review: "needs_review",
          capture_reason: inferredReason,
          source_trace_id: attachSource ? traceId : null,
          source_span_id: attachSource ? span.span_id : null,
          source_span_name: attachSource ? span.name : null,
          source_span_kind: attachSource ? displayKind : null,
        },
      });
      if (res.duplicate) {
        setDuplicate({ datasetId: dsId });
        return;
      }
      setFeedback({ tone: "success", text: "Saved — published as a new dataset version." });
      setTimeout(() => onOpenChange(false), 700);
    } catch {
      setFeedback({ tone: "error", text: "Could not save test case." });
    }
  };

  return (
    <div className="animate-slide-in-right fixed inset-y-0 right-0 z-50 flex w-[560px] max-w-[96vw] flex-col border-l border-border bg-background shadow-xl">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-[13px] font-semibold">Save as test case</h2>
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          aria-label="Close"
          className="rounded-sm text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-1 focus:ring-ring"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 py-3">
        <FormCard label="Dataset">
          <Select value={datasetId} onValueChange={setDatasetId}>
            <SelectTrigger className="h-7 text-[13px]">
              <SelectValue placeholder="Select dataset" />
            </SelectTrigger>
            <SelectContent>
              {datasets.map((item) => (
                <SelectItem key={item.id} value={item.id} className="text-[12px]">
                  {item.name}
                </SelectItem>
              ))}
              <SelectItem
                value={NEW_DATASET}
                icon={<Plus className="h-4 w-4" />}
                className="mt-1 border-t border-border text-[12px]"
              >
                New dataset
              </SelectItem>
            </SelectContent>
          </Select>
          {creatingNew && (
            <Input
              value={newDatasetName}
              onChange={(event) => setNewDatasetName(event.target.value)}
              placeholder="New dataset name"
              autoFocus
              className="mt-2 h-7 text-[13px]"
            />
          )}
          {duplicate && (
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              This span is already a test case in this dataset. Open it instead of adding another
              row.
            </p>
          )}
        </FormCard>

        <FormCard label="Selected span">
          <div className="flex items-center gap-2">
            <SpanKindIcon kind={displayKind} inTree />
            <span className="text-[13px] font-medium">{span?.name ?? "Loading trace…"}</span>
            <span className="text-[11px] text-muted-foreground">
              {SPAN_KIND_LABEL[displayKind as keyof typeof SPAN_KIND_LABEL] ?? displayKind}
            </span>
            <span className="ml-auto flex items-center gap-1">
              <button
                type="button"
                onClick={() => navigate("up")}
                disabled={!canNavigateUp}
                aria-label="Previous span"
                className="rounded border border-border p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => navigate("down")}
                disabled={!canNavigateDown}
                aria-label="Next span"
                className="rounded border border-border p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              >
                <ArrowDown className="h-3.5 w-3.5" />
              </button>
            </span>
          </div>
          <p className="mt-2 flex items-start gap-1.5 text-[11px] text-muted-foreground">
            <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
            {boundaryHint(displayKind, span?.name ?? "")}
          </p>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Capture reason:{" "}
            <span className="font-medium text-foreground">
              {CAPTURE_REASON_LABEL[inferredReason]}
            </span>
          </p>
        </FormCard>

        <EditableValueBlock
          label="Input"
          text={input}
          onChange={setInput}
          copyable
          // Read + hand-edited most, and usually the most nested → expand it.
          seedJson="expanded"
          boxed
          minRows={2}
        />

        <div>
          <EditableValueBlock
            label="Recorded output"
            text={recordedOutput}
            onChange={() => {}}
            copyable
            // May become the expected outcome future runs are graded against, so
            // it has to be readable at a glance → expand it like Input.
            seedJson="expanded"
            boxed
            minRows={2}
            readOnly
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            What happened in production. Kept separate from the expected outcome.
          </p>
        </div>

        <FormCard label="Expected outcome">
          <div className="flex flex-col gap-1" role="radiogroup" aria-label="Expected outcome">
            {(
              [
                ["none", "Not required"],
                ["recorded", "Use recorded output"],
                ["corrected", "Enter a corrected outcome"],
              ] as Array<[ExpectedMode, string]>
            ).map(([value, label]) => (
              <label
                key={value}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-[12px]",
                  expectedMode === value ? "text-foreground" : "text-muted-foreground",
                )}
              >
                <input
                  type="radio"
                  name="expected-outcome"
                  value={value}
                  checked={expectedMode === value}
                  onChange={() => setExpectedMode(value)}
                  className="h-3.5 w-3.5 accent-foreground"
                />
                {label}
              </label>
            ))}
          </div>

          {expectedMode === "recorded" && (
            <p className="mt-2 flex items-start gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
              <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
              This will become the outcome future runs are evaluated against.
            </p>
          )}
          {expectedMode === "corrected" && (
            <div className="mt-2">
              <LineNumberedTextarea
                value={correctedExpected}
                onChange={setCorrectedExpected}
                minRows={2}
                placeholder="Corrected expected outcome"
                aria-label="Corrected expected outcome"
              />
            </div>
          )}
        </FormCard>

        <EditableValueBlock
          label="Metadata"
          text={metadata}
          onChange={setMetadata}
          copyable
          // Incidental context, usually one or two short keys → keep it inline
          // (seedFormat expands it anyway once it stops fitting on one line).
          seedJson="compact"
          boxed
          minRows={2}
        />

        <div className="border border-border">
          <div className="flex items-center justify-between border-b border-border bg-muted/50 px-3 py-1.5">
            <span className="text-[12px] font-medium text-muted-foreground">Source</span>
            <Switch checked={attachSource} onCheckedChange={setAttachSource} />
          </div>
          {attachSource ? (
            <div className="p-3">
              <dl className="flex flex-col gap-1 text-[11px]">
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Source trace</dt>
                  <dd className="font-mono text-muted-foreground">{traceId}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Source span</dt>
                  <dd className="font-mono text-muted-foreground">{span?.span_id ?? "—"}</dd>
                </div>
              </dl>
            </div>
          ) : (
            <div className="p-3">
              <p className="text-[11px] text-muted-foreground">
                Added as a manual case — no source trace or span is linked.
              </p>
            </div>
          )}
        </div>

        <p className="text-[11px] text-muted-foreground">
          This case will start as <span className="font-medium text-foreground">Needs review</span>.
          Review it from the dataset row.
        </p>
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-3">
        {feedback && (
          <span
            className={cn(
              "mr-auto text-[11px]",
              feedback.tone === "error"
                ? "text-destructive"
                : "text-emerald-600 dark:text-emerald-400",
            )}
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
        {duplicate ? (
          <Link
            href={`/projects/${projectId}/datasets/${duplicate.datasetId}`}
            className="inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-3 text-[12px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
            Open existing test case
          </Link>
        ) : (
          <Button size="sm" className="h-7 text-[12px]" onClick={handleSave} disabled={!canSave}>
            {creatingNew
              ? "Create dataset & save"
              : datasetId
                ? `Save to ${dataset?.name ?? "dataset"}`
                : "Save"}
          </Button>
        )}
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

type Lang = "python" | "typescript";

/** e.g. "Billing routing" → "billing-routing". Matches the mock's slug. */
function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}

/**
 * A 4-line initDataset snippet, Braintrust-style, for one language — identical in
 * shape to the mock's DatasetInfoChip. Indents differ on purpose: 4 spaces for
 * Python (PEP 8), 2 for TypeScript (Prettier).
 */
function sdkSnippet(lang: Lang, projectName: string, datasetSlug: string, version: string): string {
  if (lang === "python") {
    return `traceroot.init_dataset("${projectName}", {\n    "dataset": "${datasetSlug}",\n    "version": "${version}",\n})`;
  }
  return `traceroot.initDataset("${projectName}", {\n  dataset: "${datasetSlug}",\n  version: "${version}",\n});`;
}

/** SDK init snippet with a Python / TypeScript toggle — one shown at a time. */
function DatasetSdkSnippet({
  projectName,
  datasetName,
  version,
}: {
  projectName: string;
  datasetName: string;
  version: string;
}) {
  const [lang, setLang] = React.useState<Lang>("python");
  const code = sdkSnippet(lang, projectName, slugify(datasetName), version);
  return (
    <div className="overflow-hidden rounded border border-border">
      <div className="flex items-center justify-between border-b border-border bg-muted/50 px-1.5 py-1">
        <div className="flex items-center gap-0.5">
          {(["python", "typescript"] as Lang[]).map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setLang(l)}
              className={cn(
                "rounded px-1.5 py-0.5 text-xs font-medium transition-colors",
                lang === l
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {l === "python" ? "Python" : "TypeScript"}
            </button>
          ))}
        </div>
        <CopyButton value={code} className="h-6 w-6" iconClassName="h-3.5 w-3.5" title="Copy" />
      </div>
      <pre className="max-h-48 overflow-auto whitespace-pre px-2.5 py-2 font-mono text-xs leading-relaxed">
        {tokenizeCode(code).map((t, i) => (
          <span key={i} className={t.cls || undefined}>
            {t.text}
          </span>
        ))}
      </pre>
    </div>
  );
}

/**
 * "Dataset:" chip shown on a span that already backs a test case — the trace-
 * viewer marker for a span that's been saved to a dataset. Renders one chip per
 * dataset the span belongs to (current version only), each linking to it, with a
 * hover card carrying the dataset's version, last-updated, case count, and a
 * copyable SDK snippet. Nothing renders when the span isn't a saved case.
 */
export function SpanDatasetChip({
  projectId,
  traceId,
  spanId,
}: {
  projectId: string;
  traceId: string;
  spanId: string;
}) {
  const { data } = useTraceTestCases(projectId, traceId);
  const { data: project } = useProject(projectId);
  const projectName = project?.name ?? "your-project";
  const matches = (data?.data ?? []).filter((c) => c.sourceSpanId === spanId);
  if (matches.length === 0) return null;
  return (
    <TooltipProvider delayDuration={150}>
      {matches.map((c) => (
        <Tooltip key={`${c.datasetId}:${c.testCaseId}`}>
          <TooltipTrigger asChild>
            <Link
              href={`/projects/${projectId}/datasets/${c.datasetId}`}
              className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors hover:bg-muted"
              title={`In dataset ${c.datasetName}`}
            >
              <Database className="h-3 w-3 text-muted-foreground" aria-hidden />
              <span className="text-muted-foreground">Dataset:</span>
              <span className="font-medium">{c.datasetName}</span>
            </Link>
          </TooltipTrigger>
          <TooltipContent
            align="start"
            className="w-[540px] max-w-[92vw] border bg-popover px-3 pb-2 pt-3 text-xs text-popover-foreground shadow-md"
          >
            <div className="mb-2">
              <div className="font-semibold">{c.datasetName}</div>
              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-muted-foreground">
                <span>
                  Version <span className="font-mono">{c.datasetVersionLabel}</span>
                </span>
                <span className="inline-flex items-center gap-1">
                  Updated <Timestamp iso={c.datasetUpdatedAt} />
                </span>
                <span>
                  {c.caseCount} {c.caseCount === 1 ? "case" : "cases"}
                </span>
              </div>
            </div>
            <DatasetSdkSnippet
              projectName={projectName}
              datasetName={c.datasetName}
              version={c.datasetVersionLabel}
            />
          </TooltipContent>
        </Tooltip>
      ))}
    </TooltipProvider>
  );
}

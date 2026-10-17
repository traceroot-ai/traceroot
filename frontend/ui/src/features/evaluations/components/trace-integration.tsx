"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Database, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectEmpty,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CopyButton } from "@/components/ui/copy-button";
import { cn } from "@/lib/utils";
import { getTrace } from "@/lib/api/traces";
import { useSpanIO } from "@/features/traces";
import { FormCard, EditableValueBlock, Timestamp } from "@/features/offline-eval/components";
import { tokenizeCode } from "@/features/offline-eval/components/syntax";
import { useProject } from "@/features/projects/hooks";
import type { Span } from "@/types/api";
import { useDatasets, useTraceEvaluationResults, useTraceTestCases } from "../hooks";

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

/**
 * "Save as test case" — the capture drawer, wired to the
 * server. Opened from the existing trace viewer's span header. Self-contained: it
 * fetches the trace, walks its spans (up/down), lets you pick or create a
 * dataset, and persists via the server (which publishes a new dataset version).
 * The span's input becomes the proposed test input; the single editable Output field
 * seeds from the recorded output and, when edited, becomes the expected outcome.
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
  const {
    data: datasetsData,
    isLoading: datasetsLoading,
    isError: datasetsError,
  } = useDatasets(projectId, { limit: 200 });
  const datasets = datasetsData?.data ?? [];

  const { data: trace } = useQuery({
    queryKey: ["trace", projectId, traceId],
    queryFn: () => getTrace(projectId, traceId as string, ""),
    enabled: open && !!traceId,
  });

  const [datasetId, setDatasetId] = React.useState("");
  const [selectedSpanId, setSelectedSpanId] = React.useState<string | undefined>(spanId);
  const [input, setInput] = React.useState("");
  const [metadata, setMetadata] = React.useState("");
  // The single editable Output field. It seeds from the span's production output;
  // whatever it holds at Save becomes the EXPECTED outcome future runs are graded
  // against (the field normalises JSON on seed — see EditableValueBlock). The raw
  // production output isn't stored separately: to see what actually happened, follow
  // the case's source trace/span link (matching the dataset-item model).
  const [output, setOutput] = React.useState("");
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
      setDuplicate(null);
      setFeedback(null);
    }
  }, [open]);

  // Follow the tree: when the parent retargets the span — a click on a different
  // span in the span tree while this drawer is open — select it here too. The
  // drawer's own up/down nav sets internal state without changing this prop, so
  // it keeps working; only a genuine tree selection re-syncs.
  React.useEffect(() => {
    setSelectedSpanId(spanId);
  }, [spanId]);

  const spans = React.useMemo(() => trace?.spans ?? [], [trace]);
  const root = trace ? rootSpan(spans) : undefined;
  const span = React.useMemo(() => {
    if (!trace) return undefined;
    return selectedSpanId ? spans.find((s) => s.span_id === selectedSpanId) : root;
  }, [trace, selectedSpanId, spans, root]);

  // The trace-detail response OMITS span input/output/metadata — they are fetched
  // per span on demand (getSpanIO), so read them from that hook, not the span.
  const { data: spanIO } = useSpanIO(projectId, traceId ?? "", span?.span_id ?? null);
  // True only once the fetched I/O actually belongs to the currently-selected span.
  // Switching spans (nav, or a tree click) changes `span?.span_id`, and `spanIO` goes
  // undefined until the new span's fetch lands — during that window this component's
  // own `input`/`output`/`metadata` state must not sit on the PREVIOUS span's values,
  // or a Save mid-fetch would persist them under the new span's id.
  const spanIOReady = !!spanIO && !!span && spanIO.span_id === span.span_id;

  // Bumped only in the SAME commit that a genuinely new span's I/O actually lands —
  // passed as `collapseResetKey` to Input/Output/Metadata below instead of
  // `span?.span_id`. `span?.span_id` changes as soon as the tree selection does,
  // one (or more) renders before the corresponding fetch resolves and this state
  // updates; EditableValueBlock's seed effect keys its "already normalised this
  // seed" bookkeeping off `collapseResetKey` alone; pairing it with a stale
  // `span?.span_id` would let a field lock in "seeded" before its real content
  // (still the previous span's) had actually arrived, silently skipping the
  // normalisation once it does.
  const [seedGeneration, setSeedGeneration] = React.useState(0);

  // Input / output / metadata follow the fetched span I/O (incl. nav). Output reseeds
  // from the recorded output on each span (nav resets any in-progress edit). Cleared
  // while the current span's I/O hasn't arrived (or belongs to a previous span) rather
  // than left stale — see `spanIOReady`.
  React.useEffect(() => {
    if (!open) return;
    if (spanIOReady && spanIO) {
      setInput(spanIO.input ?? "");
      setMetadata(prettyJson(spanIO.metadata));
      // Normalised here (once) so the Output field never needs to write a
      // re-serialised value back up just to canonicalise it — see `outputEdited`.
      setOutput(prettyJson(spanIO.output));
      setSeedGeneration((g) => g + 1);
    } else {
      setInput("");
      setMetadata("");
      setOutput("");
    }
  }, [open, spanIO, spanIOReady]);

  // Reset the duplicate note whenever the selected span changes, or the target
  // dataset changes (picking a different dataset after a duplicate note must let
  // the user save into it, not keep pointing at the dataset that already had it).
  React.useEffect(() => {
    if (open) setDuplicate(null);
  }, [open, span?.span_id, datasetId]);

  const rootRef = React.useRef<HTMLDivElement>(null);
  const headingRef = React.useRef<HTMLHeadingElement>(null);

  // Focus the panel on open (it gets none by default — the opener stays focused)
  // and restore focus to whatever had it (the "Save as test case" button) on close.
  React.useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    headingRef.current?.focus();
    return () => {
      previouslyFocused?.focus?.();
    };
  }, [open]);

  // Non-modal: Escape closes this panel without touching the trace behind it — but
  // must not swallow Escape meant for a nested Radix layer (the Dataset select, a
  // field's format-switcher popover). Listening on the drawer's own root in the
  // BUBBLE phase (not window/capture) gets this right for free: a layer that
  // consumes Escape calls preventDefault() from `document`'s CAPTURE-phase listener,
  // which always runs before any bubble-phase listener; a layer that's portaled
  // outside this subtree (as Radix content is) never reaches this listener at all.
  // `stopPropagation` only shields the trace viewer's own Escape-to-close underneath.
  React.useEffect(() => {
    if (!open) return;
    const root = rootRef.current;
    if (!root) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.stopPropagation();
      onOpenChange(false);
    };
    root.addEventListener("keydown", onKey);
    return () => root.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

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

  // Metadata must parse to a JSON object (or be empty) to be persisted at all — see
  // CreateTestCaseRequestSchema.metadata. Validated here (surfaced below) rather than
  // only at submit time, so an array/scalar/invalid value blocks Save instead of
  // silently vanishing from a "Saved" response.
  const metadataError = (() => {
    const trimmed = metadata.trim();
    if (trimmed === "") return null;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return null;
      return 'Metadata must be a JSON object, e.g. {"key": "value"}.';
    } catch {
      return "Metadata isn't valid JSON.";
    }
  })();

  const canSave =
    !!span &&
    spanIOReady &&
    !metadataError &&
    datasets.some((d) => d.id === datasetId) &&
    !save.isPending;

  const handleSave = async () => {
    if (!span || !canSave) return;
    setFeedback(null);
    try {
      // canSave already required metadataError === null, so this is either empty or a
      // valid JSON object — never silently dropped.
      const metadataObj: Record<string, unknown> | null = metadata.trim()
        ? (JSON.parse(metadata) as Record<string, unknown>)
        : null;
      // The Output field IS the expected outcome (edited or not).
      const res = await save.mutateAsync({
        datasetId,
        body: {
          input,
          expected: output.trim() || null,
          metadata: metadataObj,
          // Provenance so the API can dedupe repeat captures and the trace's
          // SpanDatasetChip can link this case back to the span it came from.
          source_trace_id: traceId,
          source_span_id: span.span_id,
          source_span_name: span.name,
          source_span_kind: span.span_kind,
        },
      });
      if (res.duplicate) {
        setDuplicate({ datasetId });
        return;
      }
      setFeedback({ tone: "success", text: "Saved — published as a new dataset version." });
      setTimeout(() => onOpenChange(false), 700);
    } catch {
      setFeedback({ tone: "error", text: "Could not save test case." });
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      {/* Dimmed backdrop; clicking it closes the modal. */}
      <div
        className="absolute inset-0 bg-black/40"
        onClick={() => onOpenChange(false)}
        aria-hidden
      />
      {/* Centered modal panel: a wide sheet with Input/Output
          side by side, rather than a narrow right-side drawer. */}
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="save-test-case-title"
        className="relative z-10 flex max-h-[90vh] w-[min(1080px,94vw)] flex-col rounded-lg border border-border bg-background shadow-xl"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border px-5 py-3">
          <h2
            id="save-test-case-title"
            ref={headingRef}
            tabIndex={-1}
            className="text-[13px] font-semibold focus:outline-none"
          >
            Add to datasets
          </h2>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="Close"
            className="rounded-sm text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-5 py-4">
          <FormCard label="Dataset">
            <Select
              value={datasets.some((d) => d.id === datasetId) ? datasetId : ""}
              onValueChange={(value) => {
                setDatasetId(value);
                setDuplicate(null);
              }}
            >
              <SelectTrigger className="h-7 text-[13px]">
                <SelectValue placeholder="Select dataset" />
              </SelectTrigger>
              <SelectContent>
                {datasets.length ? (
                  datasets.map((item) => (
                    <SelectItem key={item.id} value={item.id} className="text-[12px]">
                      {item.name}
                    </SelectItem>
                  ))
                ) : (
                  <SelectEmpty>
                    {datasetsLoading
                      ? "Loading datasets…"
                      : datasetsError
                        ? "Couldn't load datasets"
                        : "No datasets found"}
                  </SelectEmpty>
                )}
              </SelectContent>
            </Select>
            {duplicate && (
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                This span is already a test case in this dataset. Open it instead of adding another
                row.
              </p>
            )}
          </FormCard>

          {/* Stacked Dataset → Input → Output → Metadata (mirrors the trace detail
              panel this modal is launched from); each field is only as tall as its
              content, so a short input never leaves a tall empty box. */}
          <EditableValueBlock
            label="Input"
            text={input}
            onChange={setInput}
            copyable
            formatSwitcher={false}
            // Read + hand-edited most, and usually the most nested → expand it.
            seedJson="expanded"
            boxed
            minRows={3}
            maxRows={16}
            collapseResetKey={String(seedGeneration)}
          />

          <EditableValueBlock
            label="Output"
            text={output}
            onChange={setOutput}
            copyable
            formatSwitcher={false}
            // Read and possibly hand-corrected — expand it like Input.
            seedJson="expanded"
            boxed
            minRows={3}
            maxRows={16}
            collapseResetKey={String(seedGeneration)}
          />

          <div>
            <EditableValueBlock
              label="Metadata"
              text={metadata}
              onChange={setMetadata}
              copyable
              formatSwitcher={false}
              // Incidental context, usually one or two short keys → keep it inline
              // (seedFormat expands it anyway once it stops fitting on one line).
              seedJson="compact"
              boxed
              minRows={3}
              maxRows={12}
              collapseResetKey={String(seedGeneration)}
            />
            {metadataError && <p className="mt-1 text-[11px] text-destructive">{metadataError}</p>}
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-3">
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
              Save
            </Button>
          )}
        </div>
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

/**
 * A 4-line initDataset snippet for one language — identical in shape to the
 * DatasetInfoChip. Indents differ on purpose: 4 spaces for
 * Python (PEP 8), 2 for TypeScript (Prettier). `datasetId` is the dataset's
 * real addressable id (`clientDatasetId ?? id`) the public API resolves — never
 * a slug of the display name, which addresses a wrong or non-existent dataset.
 */
function sdkSnippet(lang: Lang, projectName: string, datasetId: string, version: string): string {
  if (lang === "python") {
    return `traceroot.init_dataset("${projectName}", {\n    "dataset": "${datasetId}",\n    "version": "${version}",\n})`;
  }
  return `traceroot.initDataset("${projectName}", {\n  dataset: "${datasetId}",\n  version: "${version}",\n});`;
}

/** SDK init snippet with a Python / TypeScript toggle — one shown at a time. */
function DatasetSdkSnippet({
  projectName,
  datasetId,
  version,
}: {
  projectName: string;
  datasetId: string;
  version: string;
}) {
  const [lang, setLang] = React.useState<Lang>("python");
  const code = sdkSnippet(lang, projectName, datasetId, version);
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
      {/* pb-6 so the horizontal scrollbar at the pre's bottom doesn't overlap the
          last line (it scrolls in both axes with a small max height). */}
      <pre className="max-h-48 overflow-auto whitespace-pre px-2.5 pb-6 pt-2 font-mono text-xs leading-relaxed">
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
    <>
      {matches.map((c) => (
        // A Popover, not a Tooltip: the card's language toggle and copy button are
        // interactive, and `role="tooltip"` content is unreachable by keyboard and
        // (per ARIA) forbidden from holding focusable children. Popover opens on
        // click/Enter/Space, so it works for keyboard and touch alike; the trigger
        // itself is a button, and the dataset link lives inside the card instead of
        // being the trigger, so there's still a keyboard path to both.
        <Popover key={`${c.datasetId}:${c.testCaseId}`}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors hover:bg-muted"
              title={`In dataset ${c.datasetName}`}
            >
              <Database className="h-3 w-3 text-muted-foreground" aria-hidden />
              <span className="text-muted-foreground">Dataset:</span>
              <span className="font-medium">{c.datasetName}</span>
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-[540px] max-w-[92vw] border bg-popover px-3 pb-2 pt-3 text-xs text-popover-foreground shadow-md"
          >
            <div className="mb-2 flex items-start justify-between gap-2">
              <div>
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
              <Link
                href={`/projects/${projectId}/datasets/${c.datasetId}`}
                className="inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                Open
                <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            </div>
            <DatasetSdkSnippet
              projectName={projectName}
              // Address the dataset by its real id (the "ds_…" the SDK chose, or
              // the cuid for a UI-authored one) — both resolve server-side; a slug
              // of the display name would target the wrong or a missing dataset.
              datasetId={c.datasetClientId ?? c.datasetId}
              version={c.datasetVersionLabel}
            />
          </PopoverContent>
        </Popover>
      ))}
    </>
  );
}

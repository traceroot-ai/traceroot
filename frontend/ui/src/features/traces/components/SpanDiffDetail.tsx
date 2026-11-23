"use client";

import { useMemo, useState, type ReactNode } from "react";
import { EyeOff } from "lucide-react";
import { SpanStatus } from "@traceroot/core";
import { DOMAIN_ICONS } from "@/components/icons/domain-icons";
import { Button } from "@/components/ui/button";
import { normalizeForDiff } from "@/lib/eval/line-diff";
import { describeMatchReason } from "@/lib/eval/span-match";
import {
  metricDirection,
  type MetricPair,
  type UnionNode,
  type UnionNodeMetrics,
} from "@/lib/eval/union-tree";
import { cn, formatCost, formatDuration, formatTokens } from "@/lib/utils";
import type { Span, TraceDetail } from "@/types/api";
import { useSpanIO } from "../hooks";
import { getTraceDuration, getTraceTokenUsage, getTraceTotalCost } from "../utils";
import { beforeAfter, moveClass } from "../utils/diff";
import { splitInternalMetadata } from "../utils/metadata";
import { DiffBox, DiffLayoutToggle } from "./DiffBox";
import { TraceIOSection } from "./TraceIOValue";
import { ValueDiff, type DiffLayout, type DiffSide } from "./ValueDiff";

/** How one side of a diff is named: "Baseline · #1", with its run's dot. */
export interface DiffSideLabel {
  label: string;
  tag?: string;
  /** The colour class of the side's run dot. */
  dot?: string;
}

/** Diff mode for the span detail panel: the selection beside its counterpart in a baseline
 *  trace of the same case. */
export interface SpanInfoDiff {
  /** The baseline trace; null when there is none, which leaves only the root's host
   *  content to show. */
  baseline: TraceDetail | null;
  /** The selected span as the union of both traces has it; null at the trace root. */
  node: UnionNode | null;
  /** Both traces measured their timings and usage, so the chips compare them. */
  measured: boolean;
  /** At the trace root: chips in place of the latency, token and cost chips, and boxes in
   *  place of Input, Output and Metadata (the evaluation comparison's case). */
  root?: { tags?: ReactNode; body?: ReactNode };
  /** How each side is named in a diff; "Baseline" and "This run" unless the host says. */
  sides?: { baseline: DiffSideLabel; candidate: DiffSideLabel };
  layout: DiffLayout;
  onLayoutChange: (layout: DiffLayout) => void;
}

const DEFAULT_SIDES = {
  baseline: { label: "Baseline" },
  candidate: { label: "This run" },
} satisfies SpanInfoDiff["sides"];

// A prompt or tool result can run to megabytes; a box shows this much of each value until
// asked for the rest.
const IO_PREVIEW_CHARS = 20_000;

type Field = "input" | "output" | "metadata";
const FIELDS: { field: Field; title: string }[] = [
  { field: "input", title: "Input" },
  { field: "output", title: "Output" },
  { field: "metadata", title: "Metadata" },
];

/** One side's input, output and metadata, or why one is missing. */
interface SideValues {
  values: Record<Field, string | null>;
  redacted: boolean;
  loading: boolean;
  failed: boolean;
  /** Where image references in its values load from. */
  traceId: string;
  spanId: string | null;
}

/** A span's values, fetched under its own trace; a placeholder for a span that never
 *  arrived has none stored. A provided trace (a reconstruction) carries them on the span. */
function useSpanValues(projectId: string, traceId: string, span: Span | null): SideValues {
  const spanId = span && !span.pending ? span.span_id : null;
  const { data, isLoading, isError } = useSpanIO(projectId, traceId, spanId);
  const { metadata, redacted } = splitInternalMetadata(data?.metadata ?? span?.metadata ?? null);
  return {
    values: {
      input: data?.input ?? span?.input ?? null,
      output: data?.output ?? span?.output ?? null,
      metadata,
    },
    redacted,
    loading: spanId !== null && !!isLoading,
    failed: !!isError,
    traceId,
    spanId,
  };
}

/** A whole trace's values, which the trace carries. */
function traceValues(trace: TraceDetail): SideValues {
  const { metadata } = splitInternalMetadata(trace.metadata);
  return {
    values: { input: trace.input, output: trace.output, metadata },
    redacted: false,
    loading: false,
    failed: false,
    traceId: trace.trace_id,
    // Trace input and output are the root span's, so image references load through it.
    spanId: trace.spans.find((s) => !s.parent_span_id && !s.pending)?.span_id ?? null,
  };
}

/** Both sides' values for the selection: each side's span, or at the root each trace. A
 *  side the selection doesn't exist on is null. */
function useDiffSides(projectId: string, trace: TraceDetail, diff: SpanInfoDiff) {
  const { node, baseline } = diff;
  const baselineSpan = useSpanValues(projectId, baseline?.trace_id ?? "", node?.baseline ?? null);
  const candidateSpan = useSpanValues(projectId, trace.trace_id, node?.candidate ?? null);
  if (!node) {
    return { baseline: baseline ? traceValues(baseline) : null, candidate: traceValues(trace) };
  }
  return {
    baseline: node.baseline ? baselineSpan : null,
    candidate: node.candidate ? candidateSpan : null,
  };
}

const CHIP = "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs";
const STATE_CLASS: Record<UnionNode["state"], string> = {
  matched: "",
  added: "text-success",
  removed: "text-destructive",
};

/** How the selected span came to be paired, or which run alone has it. */
export function DiffStateChip({ node }: { node: UnionNode }) {
  const [word, reason] =
    node.state === "matched"
      ? ["Matched", describeMatchReason(node.reason).replace(/^Matched /, "")]
      : node.state === "added"
        ? ["Added", "not in the baseline"]
        : ["Removed", "only in the baseline"];
  return (
    <div data-diff-chip="state" className={CHIP}>
      <span className={cn("font-medium", STATE_CLASS[node.state])}>{word}</span>{" "}
      <span className="text-muted-foreground">· {reason}</span>
    </div>
  );
}

/** "+200ms": the change from baseline to this run, signed. */
const signed = (delta: number, format: (n: number) => string) =>
  `${delta > 0 ? "+" : "−"}${format(Math.abs(delta))}`;

/** A figure chip: before → after with the change coloured by direction, or the one value a
 *  side-only span has. Nothing when neither side has the figure. */
function FigureChip({
  name,
  label,
  icon: Icon,
  metric,
  pair,
  format,
  oneSided,
}: {
  name: string;
  label?: string;
  icon: typeof DOMAIN_ICONS.latency;
  metric: keyof UnionNodeMetrics;
  pair: MetricPair;
  format: (n: number) => string;
  /** The span only one run has: its figure alone. */
  oneSided: boolean;
}) {
  if (pair.baseline === null && pair.candidate === null) return null;
  const delta =
    !oneSided && pair.baseline !== null && pair.candidate !== null
      ? pair.candidate - pair.baseline
      : null;
  return (
    <div data-diff-chip={name} className={CHIP}>
      <Icon className="h-3 w-3 text-muted-foreground" />
      {label && <span className="text-muted-foreground">{label}</span>}
      <span className="font-medium">
        {oneSided ? format((pair.candidate ?? pair.baseline)!) : beforeAfter(pair, format)}
      </span>
      {delta !== null && delta !== 0 && (
        <span className={moveClass(metricDirection(metric, pair))}>{signed(delta, format)}</span>
      )}
    </div>
  );
}

const traceFigures = (baseline: TraceDetail | null, trace: TraceDetail): UnionNodeMetrics => ({
  durationMs: {
    baseline: baseline && getTraceDuration(baseline),
    candidate: getTraceDuration(trace),
  },
  totalTokens: {
    baseline: (baseline && getTraceTokenUsage(baseline)?.totalTokens) ?? null,
    candidate: getTraceTokenUsage(trace)?.totalTokens ?? null,
  },
  cost: {
    baseline: baseline && getTraceTotalCost(baseline),
    candidate: getTraceTotalCost(trace),
  },
});

/**
 * The chips row's figures in diff mode: latency, tokens and cost before → after (when both
 * traces measured them), a change of status or model, and the redaction marker for either
 * side. At the root, the host's own chips when it has them.
 */
export function SpanDiffChips({
  projectId,
  trace,
  diff,
}: {
  projectId: string;
  trace: TraceDetail;
  diff: SpanInfoDiff;
}) {
  const sides = useDiffSides(projectId, trace, diff);
  const { node } = diff;
  if (!node && diff.root?.tags) return <>{diff.root.tags}</>;

  const figures = node ? node.metrics : traceFigures(diff.baseline, trace);
  const oneSided = !!node && node.state !== "matched";
  const span = node && (node.candidate ?? node.baseline);
  const statusChange =
    node?.state === "matched" && node.baseline.status !== node.candidate.status
      ? `${node.baseline.status} → ${node.candidate.status}`
      : null;
  const model =
    node?.state === "matched" && node.baseline.model_name !== node.candidate.model_name
      ? `${node.baseline.model_name ?? "—"} → ${node.candidate.model_name ?? "—"}`
      : span?.model_name;
  const redacted = [sides.baseline, sides.candidate].some((s) => s?.redacted);

  return (
    <>
      {diff.measured && (
        <FigureChip
          name="latency"
          label="Latency:"
          icon={DOMAIN_ICONS.latency}
          metric="durationMs"
          pair={figures.durationMs}
          format={formatDuration}
          oneSided={oneSided}
        />
      )}
      {statusChange ? (
        <div data-diff-chip="status" className={CHIP}>
          <span className="text-muted-foreground">Status:</span>
          <span className="font-medium">{statusChange}</span>
        </div>
      ) : (
        span?.status === SpanStatus.ERROR && (
          <div className="inline-flex items-center gap-1.5 rounded-md bg-danger-soft px-2.5 py-1 text-xs font-medium text-danger">
            <DOMAIN_ICONS.error className="h-3 w-3" />
            ERROR
          </div>
        )
      )}
      {model && (
        <div
          data-diff-chip="model"
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-xs text-primary-ink"
        >
          <DOMAIN_ICONS.model className="h-3 w-3" />
          {model}
        </div>
      )}
      {redacted && (
        <div
          className={CHIP}
          title="The app ran its redaction function on this span before sending it, in one run or both. Anything it removed never reached traceroot."
        >
          <EyeOff className="h-3 w-3 text-muted-foreground" />
          <span className="font-medium">Redacted by your app</span>
        </div>
      )}
      {diff.measured && (
        <>
          <FigureChip
            name="tokens"
            icon={DOMAIN_ICONS.tokens}
            metric="totalTokens"
            pair={figures.totalTokens}
            format={formatTokens}
            oneSided={oneSided}
          />
          <FigureChip
            name="cost"
            icon={DOMAIN_ICONS.cost}
            metric="cost"
            pair={figures.cost}
            format={formatCost}
            oneSided={oneSided}
          />
        </>
      )}
    </>
  );
}

/** Why a side has no value to show. */
const missingText = (side: SideValues, field: Field) =>
  side.loading ? "Loading…" : side.failed ? `Couldn't load this span's ${field}` : `No ${field}`;

/** One field compared across both runs, in its box with the layout toggle. A long value
 *  shows its start until asked for in full; the whole values are still compared. */
function DiffField({
  field,
  title,
  before,
  after,
  sides,
  layout,
  onLayoutChange,
}: {
  field: Field;
  title: string;
  before: SideValues;
  after: SideValues;
  sides: NonNullable<SpanInfoDiff["sides"]>;
  layout: DiffLayout;
  onLayoutChange: (layout: DiffLayout) => void;
}) {
  const [full, setFull] = useState(false);
  const rawBefore = before.values[field];
  const rawAfter = after.values[field];
  const textBefore = useMemo(() => rawBefore && normalizeForDiff(rawBefore), [rawBefore]);
  const textAfter = useMemo(() => rawAfter && normalizeForDiff(rawAfter), [rawAfter]);
  const long = [textBefore, textAfter].some((t) => (t?.length ?? 0) > IO_PREVIEW_CHARS);
  const side = (label: DiffSideLabel, values: SideValues, text: string | null): DiffSide => ({
    ...label,
    text,
    missing: missingText(values, field),
  });
  return (
    <DiffBox title={title} actions={<DiffLayoutToggle layout={layout} onChange={onLayoutChange} />}>
      <div className="space-y-2">
        {long && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <span>
              {full
                ? "Showing each value in full."
                : `Showing the first ${IO_PREVIEW_CHARS.toLocaleString("en-US")} characters of each value.`}
            </span>
            {/* One button for both states, so focus stays on it when it toggles. */}
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[12px]"
              onClick={() => setFull((v) => !v)}
            >
              {full ? "Show less" : "Show full"}
            </Button>
          </div>
        )}
        <ValueDiff
          before={side(sides.baseline, before, textBefore)}
          after={side(sides.candidate, after, textAfter)}
          layout={layout}
          valueName={field}
          previewChars={full ? undefined : IO_PREVIEW_CHARS}
        />
      </div>
    </DiffBox>
  );
}

/**
 * Input, Output and Metadata in diff mode: each compared across both runs in its box, or,
 * for a span only one run has, that run's values in the panel's usual boxes. At the root,
 * the host's own boxes when it has them.
 */
export function SpanDiffIO({
  projectId,
  trace,
  diff,
  selectionId,
}: {
  projectId: string;
  trace: TraceDetail;
  diff: SpanInfoDiff;
  /** Resets each box's own state (a value shown in full) when the selection changes. */
  selectionId: string;
}) {
  const sides = useDiffSides(projectId, trace, diff);
  if (!diff.node && diff.root?.body) return <>{diff.root.body}</>;

  const { baseline, candidate } = sides;
  if (baseline && candidate) {
    return (
      <>
        {FIELDS.map(({ field, title }) => (
          <DiffField
            key={`${selectionId}:${field}`}
            field={field}
            title={title}
            before={baseline}
            after={candidate}
            sides={diff.sides ?? DEFAULT_SIDES}
            layout={diff.layout}
            onLayoutChange={diff.onLayoutChange}
          />
        ))}
      </>
    );
  }

  // One run alone has the span: its values, as the panel shows any span's.
  const only = (candidate ?? baseline)!;
  return (
    <>
      {FIELDS.map(({ field, title }) => (
        <TraceIOSection
          key={`${selectionId}:${field}`}
          title={title}
          content={only.values[field]}
          loading={only.loading}
          onCopy={
            only.values[field]
              ? () => navigator.clipboard.writeText(only.values[field]!)
              : undefined
          }
          // A whole trace's metadata has no span behind it.
          attachmentSource={
            only.spanId && (diff.node || field !== "metadata")
              ? { projectId, traceId: only.traceId, spanId: only.spanId }
              : null
          }
        />
      ))}
    </>
  );
}

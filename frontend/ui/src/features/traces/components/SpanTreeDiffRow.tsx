"use client";

import type { CSSProperties, MouseEvent } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { SpanStatus } from "@traceroot/core";
import { DOMAIN_ICONS } from "@/components/icons/domain-icons";
import { describeMatchReason } from "@/lib/eval/span-match";
import {
  isMovedNode,
  metricDirection,
  unionNodeName,
  type MetricPair,
  type UnionNode,
  type UnionNodeMetrics,
  type UnionNodeState,
} from "@/lib/eval/union-tree";
import { cn, formatDuration, formatTokens } from "@/lib/utils";
import type { TraceDetail } from "@/types/api";
import { getTraceDuration, getTraceTokenUsage, getTraceTotalCost } from "../utils";
import { beforeAfter, moveClass } from "../utils/diff";
import { SpanKindIcon } from "./SpanKindIcon";
import { SpanTreeConnector } from "./SpanTreeConnector";

const NAME_CLASS: Record<UnionNodeState, string> = {
  matched: "",
  added: "text-success",
  removed: "text-destructive",
};

// The same slots, sizes and container-query breakpoints as a plain row's figures, widened
// for the longer "before → after" text.
const DURATION_CLASS = "hidden shrink-0 whitespace-nowrap text-[12px] @[100px]:inline-flex";
const TOKENS_CLASS =
  "hidden shrink-0 items-center gap-0.5 whitespace-nowrap text-[12px] font-medium @[200px]:inline-flex";
const COST_CLASS =
  "hidden shrink-0 items-center gap-0.5 whitespace-nowrap text-[12px] @[300px]:inline-flex";

/** One of a node's figures: before → after on a span both runs have, coloured by which way
 *  it moved; the one run's figure on a span only it has. Nothing when it has none. */
function NodeFigure({
  node,
  metric,
  format,
}: {
  node: UnionNode;
  metric: keyof UnionNodeMetrics;
  format: (n: number) => string;
}) {
  const pair = node.metrics[metric];
  const only =
    node.state === "added" ? pair.candidate : node.state === "removed" ? pair.baseline : null;
  if (
    node.state !== "matched" ? only === null : pair.baseline === null && pair.candidate === null
  ) {
    return null;
  }
  // An evaluation's usage follows the output it judged, so it is shown but never coloured.
  const tone = node.state === "matched" && !node.evaluator ? metricDirection(metric, pair) : null;
  const text = node.state === "matched" ? beforeAfter(pair, format) : format(only!);
  return metric === "durationMs" ? (
    <span data-metric="duration" className={cn(DURATION_CLASS, moveClass(tone))}>
      {text}
    </span>
  ) : (
    <span data-metric="tokens" className={cn(TOKENS_CLASS, moveClass(tone))}>
      <DOMAIN_ICONS.tokens className="h-2.5 w-2.5" />
      {text}
    </span>
  );
}

/**
 * One node of the union of two traces in the span tree's own row style: indented with its
 * connector lines and kind, its name green when only this trace has it and red when only
 * the baseline does, flagged when it ran under another parent, and its duration and tokens
 * before → after. An evaluation's scorer spans read muted.
 */
export function SpanTreeDiffRow({
  node,
  style,
  selected,
  hovered,
  compact,
  measured,
  hasChildren,
  collapsed,
  onSelect,
  onToggleCollapse,
  onMouseEnter,
  onMouseLeave,
}: {
  node: UnionNode;
  style: CSSProperties;
  selected: boolean;
  hovered: boolean;
  compact: boolean;
  /** Both traces carry measured timings and usage (neither is a reconstruction). */
  measured: boolean;
  hasChildren: boolean;
  collapsed: boolean;
  onSelect: () => void;
  onToggleCollapse: (e: MouseEvent) => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const span = node.candidate ?? node.baseline;
  return (
    <div
      data-diff-state={node.state}
      className={cn(
        "group flex cursor-pointer items-center border-b border-border/5 transition-colors",
        hovered ? "bg-muted" : "bg-transparent",
        selected && "bg-accent",
      )}
      style={style}
      onMouseEnter={(e) => {
        e.stopPropagation();
        onMouseEnter();
      }}
      onMouseLeave={(e) => {
        e.stopPropagation();
        onMouseLeave();
      }}
      onClick={onSelect}
    >
      {/* The trace row sits at level 0, so the spans start one level in. */}
      <SpanTreeConnector
        level={node.level + 1}
        isTerminal={node.isTerminal}
        parentLevels={node.parentLevels.map((l) => l + 1)}
      />
      <div className="flex min-w-0 flex-1 items-center gap-1.5 pr-2">
        <SpanKindIcon kind={span.span_kind} inTree />
        <span
          data-span-name
          className={cn(
            "min-w-0 shrink truncate text-xs",
            node.evaluator ? "text-muted-foreground" : NAME_CLASS[node.state],
            span.pending && "text-muted-foreground/60",
          )}
        >
          {unionNodeName(node)}
        </span>
        {node.state === "matched" && isMovedNode(node) && (
          <span
            className="shrink-0 whitespace-nowrap text-[12px] text-muted-foreground"
            title={describeMatchReason(node.reason)}
          >
            moved
          </span>
        )}
        {span.status === SpanStatus.ERROR && (
          <span className="shrink-0 whitespace-nowrap rounded bg-danger-soft px-1 py-0.5 text-[12px] font-medium text-danger">
            ERROR
          </span>
        )}
        <div className="flex min-w-0 flex-1 items-center justify-start gap-1.5 @container">
          {!compact && measured && (
            <>
              <NodeFigure node={node} metric="durationMs" format={formatDuration} />
              <NodeFigure node={node} metric="totalTokens" format={formatTokens} />
            </>
          )}
        </div>
        {hasChildren && (
          <button
            type="button"
            onClick={onToggleCollapse}
            className="shrink-0 rounded p-0.5 transition-colors hover:bg-muted"
            aria-label={collapsed ? "Expand" : "Collapse"}
          >
            {collapsed ? (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            )}
          </button>
        )}
      </div>
    </div>
  );
}

/** The trace row's figures in diff mode: the whole trace's duration, tokens and cost on
 *  the baseline, then on this trace. */
export function TraceRowDiffFigures({
  trace,
  baseline,
}: {
  trace: TraceDetail;
  baseline: TraceDetail;
}) {
  const figures: {
    metric: keyof UnionNodeMetrics;
    name: string;
    className: string;
    pair: MetricPair;
    format: (n: number) => string;
    icon?: typeof DOMAIN_ICONS.tokens;
  }[] = [
    {
      metric: "durationMs",
      name: "duration",
      className: DURATION_CLASS,
      pair: { baseline: getTraceDuration(baseline), candidate: getTraceDuration(trace) },
      format: formatDuration,
    },
    {
      metric: "totalTokens",
      name: "tokens",
      className: TOKENS_CLASS,
      pair: {
        baseline: getTraceTokenUsage(baseline)?.totalTokens ?? null,
        candidate: getTraceTokenUsage(trace)?.totalTokens ?? null,
      },
      format: formatTokens,
      icon: DOMAIN_ICONS.tokens,
    },
    {
      metric: "cost",
      name: "cost",
      className: COST_CLASS,
      pair: { baseline: getTraceTotalCost(baseline), candidate: getTraceTotalCost(trace) },
      // As the plain trace row shows it.
      format: (n) => n.toFixed(4),
      icon: DOMAIN_ICONS.cost,
    },
  ];
  return (
    <>
      {figures
        .filter(({ pair }) => pair.baseline !== null || pair.candidate !== null)
        .map(({ metric, name, className, pair, format, icon: Icon }) => (
          <span
            key={name}
            data-metric={name}
            className={cn(className, moveClass(metricDirection(metric, pair)))}
          >
            {Icon && <Icon className="h-2.5 w-2.5" />}
            {beforeAfter(pair, format)}
          </span>
        ))}
    </>
  );
}

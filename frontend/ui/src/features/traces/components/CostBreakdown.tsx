import { formatCost } from "@/lib/utils";
import { summarizeCostDetails } from "../utils";
import { MetricDelta } from "./MetricDelta";

interface CostBreakdownProps {
  details: Record<string, number> | null | undefined;
  /** Baseline cost details (trace diff mode) — renders a ± delta beside each row. */
  baselineDetails?: Record<string, number> | null;
}

function Row({
  label,
  value,
  baseline,
  emphasis,
}: {
  label: string;
  value: number;
  baseline?: number;
  emphasis?: "section" | "total";
}) {
  return (
    <div
      className={
        emphasis === "total"
          ? "mt-2 flex justify-between gap-8 border-t border-border/60 pt-1 font-semibold"
          : emphasis === "section"
            ? "flex justify-between gap-8 border-b border-border/60 pb-1 font-medium"
            : "flex justify-between gap-8 text-muted-foreground"
      }
    >
      <span>{label}</span>
      <span className="tabular-nums">
        {formatCost(value)}
        {baseline !== undefined && value !== baseline && (
          <MetricDelta delta={value - baseline} format={formatCost} />
        )}
      </span>
    </div>
  );
}

/**
 * Hierarchical "Cost breakdown" panel — the dollar analogue of
 * TokenUsageBreakdown. Input cost splits into uncached input,
 * cache read and cache write; output cost is shown on its own (reasoning is part
 * of output, already priced at the output rate). The Total is the sum of the
 * categories and reconciles to the span/trace cost chip when prices are unchanged.
 *
 * In trace diff mode `baselineDetails` is supplied and each row gains a ± delta.
 */
export function CostBreakdown({ details, baselineDetails }: CostBreakdownProps) {
  const c = summarizeCostDetails(details);
  const b = baselineDetails !== undefined ? summarizeCostDetails(baselineDetails) : undefined;

  return (
    <div className="min-w-[220px] text-xs">
      <div className="mb-2 font-semibold">Cost breakdown</div>

      <Row label="Input cost" value={c.inputCost} baseline={b?.inputCost} emphasis="section" />
      <div className="mt-1 space-y-0.5">
        <Row label="uncached" value={c.inputUncachedCost} baseline={b?.inputUncachedCost} />
        <Row label="cache read" value={c.cacheReadCost} baseline={b?.cacheReadCost} />
        <Row label="cache write" value={c.cacheWriteCost} baseline={b?.cacheWriteCost} />
      </div>

      <div className="mt-2">
        <Row label="Output cost" value={c.outputCost} baseline={b?.outputCost} emphasis="section" />
      </div>
      <div className="mt-1 space-y-0.5">
        <Row label="output" value={c.outputCost} baseline={b?.outputCost} />
      </div>

      <Row label="Total cost" value={c.total} baseline={b?.total} emphasis="total" />
    </div>
  );
}

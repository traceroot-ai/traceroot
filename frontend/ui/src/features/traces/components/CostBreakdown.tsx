import { formatCost } from "@/lib/utils";
import { summarizeCostDetails } from "../utils";

interface CostBreakdownProps {
  details: Record<string, number> | null | undefined;
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between gap-8 text-muted-foreground">
      <span>{label}</span>
      <span className="tabular-nums">{formatCost(value)}</span>
    </div>
  );
}

/**
 * Hierarchical "Cost breakdown" panel — the dollar analogue of
 * TokenUsageBreakdown. Input cost splits into uncached input,
 * cache read and cache write; output cost is shown on its own (reasoning is part
 * of output, already priced at the output rate). The Total is the sum of the
 * categories and reconciles to the span/trace cost chip when prices are unchanged.
 */
export function CostBreakdown({ details }: CostBreakdownProps) {
  const c = summarizeCostDetails(details);

  return (
    <div className="min-w-[220px] text-xs">
      <div className="mb-2 font-semibold">Cost breakdown</div>

      <div className="flex justify-between gap-8 border-b border-border/60 pb-1 font-medium">
        <span>Input cost</span>
        <span className="tabular-nums">{formatCost(c.inputCost)}</span>
      </div>
      <div className="mt-1 space-y-0.5">
        <Row label="uncached" value={c.inputUncachedCost} />
        <Row label="cache read" value={c.cacheReadCost} />
        <Row label="cache write" value={c.cacheWriteCost} />
      </div>

      <div className="mt-2 flex justify-between gap-8 border-b border-border/60 pb-1 font-medium">
        <span>Output cost</span>
        <span className="tabular-nums">{formatCost(c.outputCost)}</span>
      </div>
      <div className="mt-1 space-y-0.5">
        <Row label="output" value={c.outputCost} />
      </div>

      <div className="mt-2 flex justify-between gap-8 border-t border-border/60 pt-1 font-semibold">
        <span>Total cost</span>
        <span className="tabular-nums">{formatCost(c.total)}</span>
      </div>
    </div>
  );
}

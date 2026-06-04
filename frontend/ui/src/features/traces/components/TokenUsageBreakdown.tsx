import { formatExactTokens } from "@/lib/utils";

interface TokenUsageBreakdownProps {
  inputTokens: number | null | undefined;
  outputTokens: number | null | undefined;
  totalTokens: number | null | undefined;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  reasoningTokens?: number | null;
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between gap-8 text-muted-foreground">
      <span>{label}</span>
      <span className="tabular-nums">{formatExactTokens(value)}</span>
    </div>
  );
}

/**
 * Hierarchical "Usage breakdown" panel for a span's token counts (issue #958).
 *
 * Input usage (gross input_tokens) splits into its cache components and the
 * remaining uncached input; output usage splits into reasoning and plain
 * output. The cache sub-rows always render — even at zero — so it's clear we
 * track cache tokens; reasoning renders only when non-zero (it's specific to
 * reasoning models). The uncached `input`/`output` leaf rows always render so
 * the section totals reconcile. Values are shown exactly (comma-grouped), not
 * compactly — this is the precise breakdown behind the compact `x → y (z)` chip.
 */
export function TokenUsageBreakdown({
  inputTokens,
  outputTokens,
  totalTokens,
  cacheReadTokens,
  cacheWriteTokens,
  reasoningTokens,
}: TokenUsageBreakdownProps) {
  const input = inputTokens ?? 0;
  const output = outputTokens ?? 0;
  const total = totalTokens ?? input + output;
  const cacheRead = cacheReadTokens ?? 0;
  const cacheWrite = cacheWriteTokens ?? 0;
  const reasoning = reasoningTokens ?? 0;
  // Disjoint remainders so each section's rows sum to its total.
  const uncachedInput = Math.max(input - cacheRead - cacheWrite, 0);
  const plainOutput = Math.max(output - reasoning, 0);

  return (
    <div className="min-w-[220px] text-xs">
      <div className="mb-2 font-semibold">Usage breakdown</div>

      <div className="flex justify-between gap-8 border-b border-border/60 pb-1 font-medium">
        <span>Input usage</span>
        <span className="tabular-nums">{formatExactTokens(input)}</span>
      </div>
      <div className="mt-1 space-y-0.5">
        {/* Always shown (even at zero) so it's clear cache tokens are tracked. */}
        <Row label="cache read" value={cacheRead} />
        <Row label="cache write" value={cacheWrite} />
        <Row label="uncached" value={uncachedInput} />
      </div>

      <div className="mt-2 flex justify-between gap-8 border-b border-border/60 pb-1 font-medium">
        <span>Output usage</span>
        <span className="tabular-nums">{formatExactTokens(output)}</span>
      </div>
      <div className="mt-1 space-y-0.5">
        {reasoning > 0 && <Row label="reasoning" value={reasoning} />}
        <Row label="output" value={plainOutput} />
      </div>

      <div className="mt-2 flex justify-between gap-8 border-t border-border/60 pt-1 font-semibold">
        <span>Total usage</span>
        <span className="tabular-nums">{formatExactTokens(total)}</span>
      </div>
    </div>
  );
}

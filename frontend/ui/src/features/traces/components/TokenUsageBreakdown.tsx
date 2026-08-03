import { formatExactTokens } from "@/lib/utils";

interface TokenUsageBreakdownProps {
  inputTokens: number | null | undefined;
  outputTokens: number | null | undefined;
  totalTokens: number | null | undefined;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  reasoningTokens?: number | null;
  usageDetails?: Record<string, number> | null;
}

interface ExtraRow {
  /** Original map key (e.g. "extra:audio_tokens") — unique, used as the React key. */
  key: string;
  label: string;
  value: number;
}

/**
 * Build display rows for the unpriced `extra:*` usage keys in `usage_details`.
 *
 * The raw `extra:*` key is preserved as the row identity so distinct keys can
 * never collapse onto the same React key. The display label humanizes the suffix
 * (underscores → spaces); when two distinct keys humanize identically (e.g.
 * `extra:some_key` vs `extra:some key`), each is disambiguated by its raw key so
 * the rows stay distinguishable during live-trace updates.
 */
export function buildExtraRows(
  usageDetails: Record<string, number> | null | undefined,
): ExtraRow[] {
  const rows: ExtraRow[] = Object.entries(usageDetails ?? {})
    .filter(([key, val]) => key.startsWith("extra:") && val > 0)
    .map(([key, val]) => ({
      key,
      label: key.substring(6).replace(/_/g, " "),
      value: val,
    }));
  const labelCounts = new Map<string, number>();
  for (const row of rows) {
    labelCounts.set(row.label, (labelCounts.get(row.label) ?? 0) + 1);
  }
  return rows.map((row) =>
    labelCounts.get(row.label)! > 1 ? { ...row, label: `${row.label} (${row.key})` } : row,
  );
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
 * Input usage (gross input_tokens) splits into uncached input and its cache
 * components (same row order as CostBreakdown); output usage splits into reasoning and plain
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
  usageDetails,
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

  // Extract extra unpriced usage fields (e.g. extra:audio_tokens). Each row keeps
  // its raw extra:* key as identity so colliding display labels cannot produce
  // duplicate React keys or unstable row reconciliation on live updates.
  const extraRows = buildExtraRows(usageDetails);

  return (
    <div className="min-w-[220px] text-xs">
      <div className="mb-2 font-semibold">Usage breakdown</div>

      <div className="flex justify-between gap-8 border-b border-border/60 pb-1 font-medium">
        <span>Input usage</span>
        <span className="tabular-nums">{formatExactTokens(input)}</span>
      </div>
      <div className="mt-1 space-y-0.5">
        {/* Always shown (even at zero) so it's clear cache tokens are tracked.
            Same row order as CostBreakdown so the two panels read in parallel. */}
        <Row label="uncached" value={uncachedInput} />
        <Row label="cache read" value={cacheRead} />
        <Row label="cache write" value={cacheWrite} />
      </div>

      <div className="mt-2 flex justify-between gap-8 border-b border-border/60 pb-1 font-medium">
        <span>Output usage</span>
        <span className="tabular-nums">{formatExactTokens(output)}</span>
      </div>
      <div className="mt-1 space-y-0.5">
        {reasoning > 0 && <Row label="reasoning" value={reasoning} />}
        <Row label="output" value={plainOutput} />
      </div>

      {extraRows.length > 0 && (
        <>
          <div className="mt-2 flex justify-between gap-8 border-b border-border/60 pb-1 font-medium">
            <span>Other usage</span>
          </div>
          <div className="mt-1 space-y-0.5">
            {extraRows.map((row) => (
              <Row key={row.key} label={row.label} value={row.value} />
            ))}
          </div>
        </>
      )}

      <div className="mt-2 flex justify-between gap-8 border-t border-border/60 pt-1 font-semibold">
        <span>Total usage</span>
        <span className="tabular-nums">{formatExactTokens(total)}</span>
      </div>
    </div>
  );
}

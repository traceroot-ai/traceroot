import type { ReactNode } from "react";

/**
 * A signed ± delta appended to a metric tag when the trace viewer is in diff mode
 * (latency / tokens / cost, vs the matched baseline span). Lower is better, so a
 * positive delta — candidate above baseline — is red and a negative one is green.
 * Renders nothing when there is no baseline value; a muted ±0 when unchanged.
 *
 * Production trace views never pass a delta, so the surrounding tag is unchanged.
 */
export function MetricDelta({
  delta,
  format,
}: {
  delta: number | null | undefined;
  format: (n: number) => string;
}): ReactNode {
  if (delta == null || !Number.isFinite(delta)) return null;
  if (delta === 0) return <span className="text-muted-foreground">±0</span>;
  const worse = delta > 0;
  return (
    <span
      className={
        worse ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"
      }
    >
      {delta > 0 ? "+" : "−"}
      {format(Math.abs(delta))}
    </span>
  );
}

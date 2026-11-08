/** A group's per-day counts as a tiny line, scaled to its own peak. */
export function Sparkline({
  values,
  width = 96,
  height = 22,
  label,
}: {
  values: readonly number[];
  width?: number;
  height?: number;
  label: string;
}) {
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? (width - 2) / (values.length - 1) : 0;
  const points = values
    .map(
      (v, i) =>
        `${(1 + i * step).toFixed(1)},${(height - 2 - (v / max) * (height - 4)).toFixed(1)}`,
    )
    .join(" ");
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
      className="text-foreground/70"
    >
      {values.length > 1 ? (
        <polyline
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ) : (
        <circle cx={width / 2} cy={height / 2} r={2} fill="currentColor" />
      )}
    </svg>
  );
}

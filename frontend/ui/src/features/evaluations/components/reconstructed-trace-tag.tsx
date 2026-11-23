/** What a result with no telemetry shows its rebuilt trace as, in the trace panel's tags. */
export function ReconstructedTraceTag() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-warning-border bg-warning-soft px-2.5 py-1 text-xs text-warning">
      Reconstructed — no telemetry was emitted for this result
    </span>
  );
}

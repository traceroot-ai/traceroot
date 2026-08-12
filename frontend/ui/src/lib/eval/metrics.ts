/**
 * The run's `scorers` JSON manifest, and how a late-resolved one folds into it.
 *
 * A scorer DEFINITION (e.g. `grade`) owns one or more EMITTED METRICS (e.g. `quality`).
 * A Score row reports the METRIC name as `scorer_name`, so anything keyed on a metric
 * must use the emitted-metric identity — never the definition name. Registration can
 * only carry the definitions (which metrics they emit is unknown until the run runs), so
 * completion is where the resolved manifest arrives and has to be folded in.
 */

/**
 * Merge a resolved manifest (from completion) into the stored one, by definition name:
 * a definition present in `incoming` replaces the stored one (carrying its resolved
 * `emitted_metrics`); definitions only in `stored` are kept. Additive + idempotent — a
 * replay carrying the same manifest produces an equal value, so nothing is written.
 */
export function mergeScorerManifests(stored: unknown, incoming: unknown): unknown[] {
  const byName = new Map<string, unknown>();
  const add = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const s of list) {
      if (s && typeof s === "object" && typeof (s as Record<string, unknown>).name === "string") {
        byName.set((s as Record<string, unknown>).name as string, s);
      }
    }
  };
  add(stored);
  add(incoming); // incoming wins on name collision — it carries the resolved metrics
  return [...byName.values()];
}

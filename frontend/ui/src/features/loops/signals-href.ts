import { serializeFiltersParam } from "@/features/filters/predicate";

/**
 * The Signals page filtered to the signals a Loop found. By name, so the Signals
 * chip reads "loop = <name>", not the hidden detector's id.
 */
export function loopSignalsHref(projectId: string, loopName: string): string {
  const params = new URLSearchParams({
    filters: serializeFiltersParam([{ field: "loop", op: "in", value: [loopName] }])!,
  });
  return `/projects/${projectId}/signals?${params}`;
}

import { JEV_OTHER } from "../../detection/jev-templates.js";
import type { SignalText } from "./types.js";

/** Group key for a Jev hit whose label question picked no category. */
export const UNCLEAR_GROUP = "unclear";

/**
 * Jev-path hits carry a category and probabilities but no written summary, so
 * they skip the embedding and the assignment model and are grouped by category:
 * one signal per (detector, category). A Jev judgment is recognised by the data
 * the Jev backend writes (category, probabilities, confidence, gate); a chat
 * detector's data never has that shape unless its output schema copies it.
 * Returns null for any other hit.
 */
export function jevGroupKey(data: unknown): string | null {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  const probabilities = d.probabilities;
  const isJev =
    "category" in d &&
    typeof d.gate === "number" &&
    typeof d.confidence === "number" &&
    probabilities !== null &&
    typeof probabilities === "object" &&
    !Array.isArray(probabilities);
  if (!isJev) return null;
  return typeof d.category === "string" && d.category ? d.category : UNCLEAR_GROUP;
}

/** Title and criteria for a category signal; fixed, not model-written. */
export function groupSignalText(groupKey: string): SignalText {
  const label =
    groupKey === JEV_OTHER
      ? "unlisted problem"
      : groupKey === UNCLEAR_GROUP
        ? "problem with no clear category"
        : groupKey.replace(/_/g, " ");
  return {
    title: label.charAt(0).toUpperCase() + label.slice(1),
    covers: `Hits this detector's decision model put in the "${groupKey}" category.`,
    excludes: "",
  };
}

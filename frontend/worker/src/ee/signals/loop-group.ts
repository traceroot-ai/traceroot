import { loopHitDataSchema, loopSignalGroupKey } from "@traceroot/core/loops";
import { UnusableAnswerError } from "./types.js";
import type { Placement } from "./write.js";

/**
 * Where a hit of a Loop's detector goes: the signal of its finding key
 * ("loop:<key>"), titled with the finding's own text when the hit creates it;
 * an existing signal keeps its title, as every grouped signal does. The Loop
 * runner writes the data (loops/findings.ts), so data that does not parse is an
 * unusable hit, never one for the models.
 */
export function loopGroup(data: unknown): Extract<Placement, { kind: "group" }> {
  const hit = loopHitDataSchema.safeParse(data);
  // Unusable, not a plain error: the round gives such a hit up after a few tries,
  // where a plain error reads as an outage and is retried for as long as it waits.
  if (!hit.success) throw new UnusableAnswerError("loop hit without valid finding data");
  const { loopFindingKey, title, covers } = hit.data;
  return {
    kind: "group",
    groupKey: loopSignalGroupKey(loopFindingKey),
    signal: { title, covers, excludes: "" },
    anchorText: title,
  };
}

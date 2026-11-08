import { cosine } from "../signals/shortlist.js";

export interface PlacementGroup {
  groupId: string;
  center: readonly number[];
  /** Largest cosine distance (1 - cosine similarity) a member may have from the center. */
  reach: number;
}

export interface Placement {
  /** Empty when the trace is inside no group's reach. */
  groupId: string;
  /** Cosine distance to the nearest center, even when it is outside the reach. */
  distance: number;
}

/**
 * Place an embedded summary in the nearest group, but only if it falls inside that
 * group's reach; otherwise it is left in no group. Never falls back to a farther
 * group, and makes no model call. Ties go to the earlier group.
 */
export function placeInGroup(
  vector: readonly number[],
  groups: readonly PlacementGroup[],
): Placement {
  let best: PlacementGroup | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const group of groups) {
    const distance = 1 - cosine(vector, group.center);
    if (distance < bestDistance) {
      best = group;
      bestDistance = distance;
    }
  }
  if (!best) return { groupId: "", distance: 1 };
  return { groupId: bestDistance <= best.reach ? best.groupId : "", distance: bestDistance };
}

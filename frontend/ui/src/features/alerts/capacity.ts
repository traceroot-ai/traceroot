/**
 * How much of the per-project alert cap is spent. `used` counts the project's
 * rules whatever their status, matching what the create endpoint enforces on.
 */
export interface AlertCapacity {
  used: number;
  max: number;
}

/** Fewer free slots than this and the list starts showing the count. */
export const LOW_CAPACITY_REMAINING = 10;

// Both predicates answer false for an absent capacity: the server is the
// enforcement, so an unknown count leaves the create path open.
export function isAtAlertCapacity(capacity?: AlertCapacity): boolean {
  return capacity !== undefined && capacity.used >= capacity.max;
}

export function isAlertCapacityLow(capacity?: AlertCapacity): boolean {
  return capacity !== undefined && capacity.max - capacity.used < LOW_CAPACITY_REMAINING;
}

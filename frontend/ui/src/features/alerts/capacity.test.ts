import { describe, expect, it } from "vitest";
import { isAlertCapacityLow, isAtAlertCapacity } from "./capacity";

describe("the alert capacity predicates", () => {
  it("reads an unknown capacity as neither full nor low, leaving the create path open", () => {
    // Loading, a failed fetch, and a response cached before the field shipped
    // all arrive here as undefined.
    expect(isAtAlertCapacity(undefined)).toBe(false);
    expect(isAlertCapacityLow(undefined)).toBe(false);
  });

  it("reads full at the cap and past it, and low only inside the last ten slots", () => {
    expect(isAtAlertCapacity({ used: 99, max: 100 })).toBe(false);
    expect(isAtAlertCapacity({ used: 100, max: 100 })).toBe(true);
    // A cap lowered under a project that is already over it still reads full.
    expect(isAtAlertCapacity({ used: 120, max: 100 })).toBe(true);

    expect(isAlertCapacityLow({ used: 90, max: 100 })).toBe(false);
    expect(isAlertCapacityLow({ used: 91, max: 100 })).toBe(true);
  });
});

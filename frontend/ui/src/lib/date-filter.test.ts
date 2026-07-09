import { describe, expect, it } from "vitest";
import {
  DATE_FILTER_OPTIONS,
  DETECTORS_DEFAULT_DATE_FILTER_ID,
  findDateFilterOption,
} from "./date-filter";

describe("DETECTORS_DEFAULT_DATE_FILTER_ID", () => {
  it("references an id that exists in DATE_FILTER_OPTIONS", () => {
    // Guards against the constant drifting from the option list: if the "14d"
    // option were renamed or removed, findDateFilterOption would silently fall
    // back to the 1d default instead of surfacing the mismatch.
    const optionIds = DATE_FILTER_OPTIONS.map((option) => option.id);

    expect(optionIds).toContain(DETECTORS_DEFAULT_DATE_FILTER_ID);
  });

  it("resolves to the 14-day window so the detectors default cannot drift to 1d", () => {
    const option = findDateFilterOption(DETECTORS_DEFAULT_DATE_FILTER_ID);

    expect(option.id).toBe("14d");
    expect(option.durationMinutes).toBe(14 * 24 * 60);
  });
});

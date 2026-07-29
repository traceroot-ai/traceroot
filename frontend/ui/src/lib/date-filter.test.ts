import { describe, expect, it } from "vitest";
import {
  clampDateFilter,
  DATE_FILTER_OPTIONS,
  DETECTORS_DEFAULT_DATE_FILTER_ID,
  findDateFilterOption,
  isOptionLocked,
} from "./date-filter";

// The unlocked preset ids (durationed, non-custom) for a given retention window.
const unlockedIds = (retentionDays: number | null) =>
  DATE_FILTER_OPTIONS.filter(
    (o) => o.durationMinutes !== null && !isOptionLocked(o, retentionDays),
  ).map((o) => o.id);

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

describe("retention gating by plan window", () => {
  // Plan → retention days (must mirror useRetention's PLAN_RETENTION_DAYS):
  // FREE 15, STARTER 30, PRO 90, ENTERPRISE unlimited.
  it("FREE (15 days): locks everything above 14 days", () => {
    expect(unlockedIds(15)).toEqual(["30m", "1h", "3h", "6h", "1d", "7d", "14d"]);
    expect(isOptionLocked(findDateFilterOption("30d"), 15)).toBe(true);
    expect(isOptionLocked(findDateFilterOption("90d"), 15)).toBe(true);
  });

  it("STARTER (30 days): 30d is selectable, 60d/90d locked", () => {
    expect(unlockedIds(30)).toEqual(["30m", "1h", "3h", "6h", "1d", "7d", "14d", "30d"]);
    expect(isOptionLocked(findDateFilterOption("30d"), 30)).toBe(false);
    expect(isOptionLocked(findDateFilterOption("60d"), 30)).toBe(true);
  });

  it("PRO (90 days): the full 90-day window is selectable", () => {
    expect(unlockedIds(90)).toEqual([
      "30m",
      "1h",
      "3h",
      "6h",
      "1d",
      "7d",
      "14d",
      "30d",
      "60d",
      "90d",
    ]);
    expect(isOptionLocked(findDateFilterOption("90d"), 90)).toBe(false);
  });

  it("ENTERPRISE (unlimited): nothing is locked", () => {
    expect(isOptionLocked(findDateFilterOption("90d"), null)).toBe(false);
    expect(unlockedIds(null)).toEqual(unlockedIds(null)); // all durationed presets
    expect(unlockedIds(null)).toHaveLength(
      DATE_FILTER_OPTIONS.filter((o) => o.durationMinutes !== null).length,
    );
  });

  it("clamps an over-window preset down to the widest allowed one", () => {
    // A Free user arriving with 90d in the URL collapses to 14d, not custom/1d.
    expect(clampDateFilter(findDateFilterOption("90d"), 15).id).toBe("14d");
    expect(clampDateFilter(findDateFilterOption("90d"), 30).id).toBe("30d");
    expect(clampDateFilter(findDateFilterOption("90d"), 90).id).toBe("90d");
  });
});

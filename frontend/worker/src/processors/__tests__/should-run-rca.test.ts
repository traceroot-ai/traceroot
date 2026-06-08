import { describe, it, expect } from "vitest";
import { shouldRunRca } from "../detector-run-processor.js";

describe("shouldRunRca", () => {
  it("returns true when the only triggered detector has RCA on", () => {
    expect(shouldRunRca([{ detectorId: "a" }], [{ id: "a", enableRca: true }])).toBe(true);
  });

  it("returns false when the only triggered detector has RCA off", () => {
    expect(shouldRunRca([{ detectorId: "a" }], [{ id: "a", enableRca: false }])).toBe(false);
  });

  it("returns true when at least one triggered detector has RCA on (mixed)", () => {
    expect(
      shouldRunRca(
        [{ detectorId: "a" }, { detectorId: "b" }],
        [
          { id: "a", enableRca: false },
          { id: "b", enableRca: true },
        ],
      ),
    ).toBe(true);
  });

  it("returns false when all triggered detectors have RCA off", () => {
    expect(
      shouldRunRca(
        [{ detectorId: "a" }, { detectorId: "b" }],
        [
          { id: "a", enableRca: false },
          { id: "b", enableRca: false },
        ],
      ),
    ).toBe(false);
  });

  it("defaults to true for a triggered detector missing from the detectors list", () => {
    expect(shouldRunRca([{ detectorId: "ghost" }], [])).toBe(true);
  });
});

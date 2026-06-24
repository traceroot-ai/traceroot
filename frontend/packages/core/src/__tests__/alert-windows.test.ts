import { describe, it, expect } from "vitest";
import { ALERT_WINDOWS, isAlertWindow } from "../constants.ts";

describe("ALERT_WINDOWS", () => {
  it("maps each token to its canonical millisecond duration", () => {
    expect(ALERT_WINDOWS).toEqual({
      off: 0,
      "5m": 300_000,
      "30m": 1_800_000,
      "1h": 3_600_000,
      "2h": 7_200_000,
    });
  });

  it("exposes exactly the five tokens, off first", () => {
    expect(Object.keys(ALERT_WINDOWS)).toEqual(["off", "5m", "30m", "1h", "2h"]);
  });

  it("isAlertWindow accepts known tokens and rejects everything else", () => {
    expect(isAlertWindow("1h")).toBe(true);
    expect(isAlertWindow("off")).toBe(true);
    expect(isAlertWindow("24h")).toBe(false);
    expect(isAlertWindow("")).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { ALERT_WINDOWS, DEFAULT_ALERT_WINDOW, isAlertWindow } from "../constants.ts";

describe("ALERT_WINDOWS", () => {
  it("maps each token to its canonical millisecond duration", () => {
    expect(ALERT_WINDOWS).toEqual({
      "1m": 60_000,
      "5m": 300_000,
      "10m": 600_000,
      "30m": 1_800_000,
      "1h": 3_600_000,
      "2h": 7_200_000,
    });
  });

  it("exposes exactly the six tokens in ascending order, 1m first", () => {
    expect(Object.keys(ALERT_WINDOWS)).toEqual(["1m", "5m", "10m", "30m", "1h", "2h"]);
  });

  it("defaults to 10m, which is a valid window", () => {
    expect(DEFAULT_ALERT_WINDOW).toBe("10m");
    expect(isAlertWindow(DEFAULT_ALERT_WINDOW)).toBe(true);
  });

  it("isAlertWindow accepts known tokens and rejects everything else", () => {
    expect(isAlertWindow("1m")).toBe(true);
    expect(isAlertWindow("1h")).toBe(true);
    // "off" was removed — every alert is now a windowed digest.
    expect(isAlertWindow("off")).toBe(false);
    expect(isAlertWindow("24h")).toBe(false);
    expect(isAlertWindow("")).toBe(false);
  });
});

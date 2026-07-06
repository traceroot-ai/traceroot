import { describe, expect, it } from "vitest";
import { decideUsageNotification } from "../usageNotifications.ts";

const CAP = 50_000;
const none = { send: "none", stampWarning: false, stampBlocked: false };

describe("decideUsageNotification", () => {
  it("does nothing below the warning threshold", () => {
    expect(decideUsageNotification({ used: 0, cap: CAP, state: null })).toEqual(none);
    expect(decideUsageNotification({ used: 39_999, cap: CAP, state: null })).toEqual(none);
  });

  it("sends the warning exactly at 80%", () => {
    expect(decideUsageNotification({ used: 40_000, cap: CAP, state: null })).toEqual({
      send: "warning",
      stampWarning: true,
      stampBlocked: false,
    });
  });

  it("does not repeat a warning already stamped", () => {
    const state = { warningSentAt: new Date("2026-07-01T00:00:00Z"), blockedSentAt: null };
    expect(decideUsageNotification({ used: 45_000, cap: CAP, state })).toEqual(none);
  });

  it("does not re-arm the warning when usage drops back below 80%", () => {
    const state = { warningSentAt: new Date("2026-07-01T00:00:00Z"), blockedSentAt: null };
    expect(decideUsageNotification({ used: 10_000, cap: CAP, state })).toEqual(none);
  });

  it("sends blocked at the cap and stamps only blocked when the warning was already sent", () => {
    const state = { warningSentAt: new Date("2026-07-01T00:00:00Z"), blockedSentAt: null };
    expect(decideUsageNotification({ used: CAP, cap: CAP, state })).toEqual({
      send: "blocked",
      stampWarning: false,
      stampBlocked: true,
    });
  });

  it("crossing 80% and 100% in one tick sends only blocked but stamps both", () => {
    expect(decideUsageNotification({ used: CAP + 5, cap: CAP, state: null })).toEqual({
      send: "blocked",
      stampWarning: true,
      stampBlocked: true,
    });
  });

  it("does not repeat the blocked email once stamped", () => {
    const state = {
      warningSentAt: new Date("2026-07-01T00:00:00Z"),
      blockedSentAt: new Date("2026-07-02T00:00:00Z"),
    };
    expect(decideUsageNotification({ used: CAP * 2, cap: CAP, state })).toEqual(none);
  });

  it("does nothing for unlimited or degenerate caps", () => {
    expect(decideUsageNotification({ used: 1_000_000, cap: Infinity, state: null })).toEqual(none);
    expect(decideUsageNotification({ used: 5, cap: 0, state: null })).toEqual(none);
  });
});

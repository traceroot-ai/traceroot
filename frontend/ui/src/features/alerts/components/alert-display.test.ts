import { describe, expect, it } from "vitest";
import type { AlertSeverity } from "@traceroot/core";
import {
  formatAlertWindow,
  resolveAlertDisplayState,
  type AlertDisplayInput,
} from "./alert-display";

// Nothing here reads a clock, so no case can pass or fail because of the day it runs on.
const RAN_AT = "2026-08-01T12:00:00.000Z";

const stateOf = (facts: Partial<AlertDisplayInput> = {}) =>
  resolveAlertDisplayState({ status: "ACTIVE", severity: "OK", lastEvaluatedAt: RAN_AT, ...facts });

const DELIVERY_CODES = [
  "no-channel",
  "no-bot-token",
  "bot-token-undecryptable",
  "retries-exhausted",
  "permanent-slack-error",
  "no-entitlement:slack",
];

describe("resolveAlertDisplayState", () => {
  it("gives each severity its own label and tone", () => {
    const badge = (severity: AlertSeverity) => {
      const { label, tone } = stateOf({ severity });
      return { label, tone };
    };

    expect(badge("OK")).toEqual({ label: "OK", tone: "ok" });
    expect(badge("ALERT")).toEqual({ label: "Alert", tone: "alert" });
    expect(badge("NO_DATA")).toEqual({ label: "No Data", tone: "warning" });
    expect(badge("UNKNOWN")).toEqual({ label: "Unknown", tone: "neutral" });
  });

  it("waits for a first check only when the row says the rule has never run", () => {
    const waiting = stateOf({ severity: "UNKNOWN", lastEvaluatedAt: null });

    expect(waiting.label).toBe("Waiting for First Check");
    expect(waiting.tone).toBe("neutral");
    expect(waiting.detail).toContain("has not run yet");

    // An omitted timestamp is not the claim that the rule never ran.
    expect(stateOf({ severity: "UNKNOWN", lastEvaluatedAt: undefined }).label).toBe("Unknown");
  });

  it("ranks Paused over Failing, and Failing over a rule that has never run", () => {
    const failedFirstRun = {
      severity: "ALERT" as const,
      lastError: "ClickHouse read timeout",
      lastEvaluatedAt: null,
    };

    // A rule that failed its own first run has already answered, and the answer was a failure.
    expect(stateOf(failedFirstRun).label).toBe("Failing");

    const paused = stateOf({ ...failedFirstRun, status: "PAUSED" });
    expect(paused.label).toBe("Paused");
    expect(paused.isPaused).toBe(true);
  });

  it("shows Failing on a rule whose last run errored, even while it still holds a green OK", () => {
    // A green badge here tells the owner a broken rule is watching their service.
    const state = stateOf({ lastError: "ClickHouse read timeout" });

    expect(state.label).toBe("Failing");
    expect(state.tone).toBe("warning");
    expect(state.detail).toContain("ClickHouse read timeout");
    // And what happens next, which the label has no room for.
    expect(state.detail).toContain("retry");
    expect(state.isPaused).toBe(false);
  });

  it("treats an empty error string as no error, not as a failure", () => {
    expect(stateOf({ lastError: "" }).label).toBe("OK");
  });

  it("turns each delivery reason into words, and keeps the raw code out of them", () => {
    const detailFor = (code: string) =>
      stateOf({ lastNotifyStatus: "FAILED", lastNotifyError: code }).detail ?? "";

    for (const code of DELIVERY_CODES) {
      // The run is still what the badge reports; delivery is the reason beneath.
      expect(stateOf({ lastNotifyStatus: "FAILED", lastNotifyError: code }).label).toBe("OK");
      expect(detailFor(code)).not.toContain(code);
    }

    // A reason with no way out of it leaves the reader stuck, so each says where to go.
    expect(detailFor("no-channel")).toContain(
      "No Slack channel is set for this workspace, so nothing was sent. Choose one in workspace settings.",
    );
    expect(detailFor("no-entitlement:slack")).toContain(
      "Slack delivery is not included in this workspace's plan.",
    );
  });

  it("quotes a code it has no words for, and does not mask the breach behind it", () => {
    const state = stateOf({
      severity: "ALERT",
      lastNotifyStatus: "FAILED",
      lastNotifyError: "channel revoked",
    });

    // The breach is the headline: a delivery fault must not demote it.
    expect(state.label).toBe("Alert");
    expect(state.tone).toBe("alert");
    // Nothing is invented for a code nobody mapped; it arrives as it was stored.
    expect(state.detail).toContain("The last notification could not be sent. (channel revoked)");
  });

  it("says whether the alert behind an undelivered page was rolled back", () => {
    const detailFor = (lastNotifyStatus: string) =>
      stateOf({ severity: "ALERT", lastNotifyStatus, lastNotifyError: "no-channel" }).detail;

    // The rollback is the difference between a breach that pages again and one recorded.
    expect(detailFor("COMPENSATED")).toContain("rolled back, so the next breach raises it again");
    expect(detailFor("FAILED")).toContain("could not be rolled back");
  });

  it("says nothing about delivery when the last page landed", () => {
    expect(stateOf({ lastNotifyStatus: "DELIVERED" })).toEqual({
      label: "OK",
      tone: "ok",
      isPaused: false,
    });
  });
});

describe("formatAlertWindow", () => {
  it("reads as a lookback, not a cadence", () => {
    expect(formatAlertWindow("10m")).toBe("Last 10m");
    expect(formatAlertWindow("1h")).toBe("Last 1h");
  });
});

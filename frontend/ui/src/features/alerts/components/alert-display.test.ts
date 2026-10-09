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
    expect(badge("UNKNOWN")).toEqual({ label: "No Data", tone: "warning" });
  });

  it("waits for a first check only when the row says the rule has never run", () => {
    const waiting = stateOf({ severity: "UNKNOWN", lastEvaluatedAt: null });

    expect(waiting.label).toBe("No Data");
    expect(waiting.tone).toBe("warning");
    expect(waiting.detail).toContain("has not run yet");

    // An omitted timestamp is not the claim that the rule never ran.
    expect(stateOf({ severity: "UNKNOWN", lastEvaluatedAt: undefined }).label).toBe("No Data");
  });

  it("ranks Parked over Paused, Paused over Failing, and Failing over a rule that has never run", () => {
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
    expect(paused.isStopped).toBe(true);

    const parked = stateOf({ ...failedFirstRun, status: "PARKED" });
    expect(parked.label).toBe("Parked");
    expect(parked.isStopped).toBe(true);
    // Not paused: nobody chose this, and the action that clears it is different.
    expect(parked.isPaused).toBe(false);
  });

  it("states the reason once, trusting it to already say what restarts the rule", () => {
    // Every real parking path bakes "edit and save" into the stored reason
    // itself (claim.ts's UNEVALUABLE_RULE_ERROR, scheduler.ts's
    // PARKED_RULE_SUFFIX), so the badge must not repeat it — that reads as the
    // same sentence twice in one popover.
    const parked = stateOf({
      status: "PARKED",
      lastError: "measure: unknown; open it and save it again to correct them",
    });

    expect(parked.detail).toBe(
      "Stopped: measure: unknown; open it and save it again to correct them.",
    );
    // The sentence this status exists to stop telling.
    expect(parked.detail).not.toContain("retry");

    // A row parked with no reason at all is the one case with nothing of its
    // own to say, so only here does the badge supply the fix itself.
    const bare = stateOf({ status: "PARKED", lastError: null });
    expect(bare.detail).toContain("cannot be evaluated");
    expect(bare.detail).toContain("Edit and save");
  });

  it("shows Failing on a rule whose last run errored, even while it still holds a green OK", () => {
    // A green badge here tells the owner a broken rule is watching their service.
    const state = stateOf({ lastError: "ClickHouse read timeout" });

    expect(state.label).toBe("Failing");
    expect(state.tone).toBe("alert");
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

  it("sends a compensated transient failure again on the next evaluation in the same state", () => {
    const detail =
      stateOf({
        severity: "ALERT",
        lastNotifyStatus: "COMPENSATED",
        lastNotifyError: "retries-exhausted",
        lastNotifySeverity: "ALERT",
      }).detail ?? "";

    expect(detail).toContain("Slack did not accept the message after several attempts.");
    expect(detail).toContain(
      "sent again on the next evaluation while the rule is still in the same state",
    );
    // The old text promised the next breach instead, contradicting the resend above.
    expect(detail).not.toContain("next breach");
    expect(detail).not.toContain("could not be rolled back");
  });

  it("does not promise a resend for a compensated row that predates attempt severities", () => {
    const detail =
      stateOf({
        severity: "ALERT",
        lastNotifyStatus: "COMPENSATED",
        lastNotifyError: "retries-exhausted",
        lastNotifySeverity: null,
      }).detail ?? "";

    // Rows from before the attempt's severity was kept are never replayed.
    expect(detail).toContain("rolled back, so the next breach raises it again");
    expect(detail).not.toContain("next evaluation");
  });

  it("tells the reader how to fix a refused configuration failure and when it sends", () => {
    for (const code of ["no-channel", "no-bot-token", "bot-token-undecryptable"]) {
      const detail =
        stateOf({
          severity: "ALERT",
          lastNotifyStatus: "FAILED",
          lastNotifyError: code,
          lastNotifySeverity: "ALERT",
        }).detail ?? "";

      expect(detail).toContain(
        "Once fixed in workspace settings, it is sent on the next evaluation while the rule is still in the same state",
      );
      // Nothing was rolled back here: the failure is recorded, not reverted.
      expect(detail).not.toContain("could not be rolled back");
    }
  });

  it("does not promise a resend for a refused configuration failure with no attempt severity", () => {
    const detail =
      stateOf({
        severity: "ALERT",
        lastNotifyStatus: "FAILED",
        lastNotifyError: "no-channel",
        lastNotifySeverity: null,
      }).detail ?? "";

    expect(detail).toContain("No Slack channel is set for this workspace");
    expect(detail).toContain("will not be sent again");
    expect(detail).not.toContain("sent on the next evaluation");
  });

  it("reports the one rollback that was attempted and failed", () => {
    const detail =
      stateOf({
        severity: "ALERT",
        lastNotifyStatus: "FAILED",
        lastNotifyError: "retries-exhausted",
        lastNotifySeverity: "ALERT",
      }).detail ?? "";

    // A successful revert records COMPENSATED instead, so FAILED here means
    // the revert itself failed — the only case this sentence fits.
    expect(detail).toContain("could not be rolled back");
    expect(detail).not.toContain("next evaluation");
  });

  it("does not resend a permanently rejected notification", () => {
    const detail =
      stateOf({
        severity: "ALERT",
        lastNotifyStatus: "FAILED",
        lastNotifyError: "permanent-slack-error",
        lastNotifySeverity: "ALERT",
      }).detail ?? "";

    expect(detail).toContain("Slack rejected the message");
    expect(detail).toContain(
      "not sent again; the rule notifies on its next change of state or renotify interval",
    );
    expect(detail).not.toContain("could not be rolled back");
  });

  it("promises nothing for failures no setting can clear", () => {
    const entitlement =
      stateOf({
        severity: "ALERT",
        lastNotifyStatus: "FAILED",
        lastNotifyError: "no-entitlement:slack",
        lastNotifySeverity: "ALERT",
      }).detail ?? "";
    expect(entitlement).toContain("not included in this workspace's plan");
    expect(entitlement).not.toContain("could not be rolled back");
    expect(entitlement).not.toContain("next evaluation");

    const superseded =
      stateOf({
        severity: "ALERT",
        lastNotifyStatus: "SUPERSEDED",
        lastNotifyError: "superseded",
        lastNotifySeverity: "ALERT",
      }).detail ?? "";
    // A superseded page belongs to a replaced emission; nothing was rolled
    // back and nothing is resent, so the reason stands alone.
    expect(superseded).not.toContain("could not be rolled back");
    expect(superseded).not.toContain("next evaluation");
  });

  it("quotes an unknown code without inventing a follow-up for it", () => {
    const detail =
      stateOf({
        severity: "ALERT",
        lastNotifyStatus: "FAILED",
        lastNotifyError: "channel revoked",
        lastNotifySeverity: "ALERT",
      }).detail ?? "";

    expect(detail).toContain("The last notification could not be sent. (channel revoked)");
    expect(detail).not.toContain("could not be rolled back");
  });

  it("says nothing about delivery when the last page landed", () => {
    expect(stateOf({ lastNotifyStatus: "DELIVERED" })).toEqual({
      label: "OK",
      tone: "ok",
      isPaused: false,
      isStopped: false,
    });
  });
});

describe("formatAlertWindow", () => {
  it("reads as a lookback, not a cadence", () => {
    expect(formatAlertWindow("10m")).toBe("Last 10m");
    expect(formatAlertWindow("1h")).toBe("Last 1h");
  });
});

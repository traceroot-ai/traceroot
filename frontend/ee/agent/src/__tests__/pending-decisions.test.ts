import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DECISION_TIMEOUT_MS,
  DECISION_TIMED_OUT_SKIP_REASON,
  PARKED_HEARTBEAT_MS,
  PendingDecisions,
  userSkipReason,
  type ConfirmationChannel,
} from "../pending-decisions.js";

function channelFor(userId: string): ConfirmationChannel {
  return { userId, emit: vi.fn(), keepalive: vi.fn() };
}

function parkOn(decisions: PendingDecisions, sessionId: string, toolName = "create_detector") {
  return decisions.park({
    sessionId,
    toolCallId: "tc-1",
    toolName,
    args: { name: "latency" },
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("PendingDecisions", () => {
  it("resolves a parked decision as create and empties the registry", async () => {
    const decisions = new PendingDecisions();
    const { decisionId, outcome } = parkOn(decisions, "s1");

    expect(decisions.pendingCount()).toBe(1);
    expect(decisions.decide(decisionId, "s1", { action: "create" })).toBe("resolved");
    await expect(outcome).resolves.toEqual({ action: "create" });
    expect(decisions.pendingCount()).toBe(0);
  });

  it("resolves skip with a narratable reason naming the tool", async () => {
    const decisions = new PendingDecisions();
    const { decisionId, outcome } = parkOn(decisions, "s1", "create_widget");

    expect(decisions.decide(decisionId, "s1", { action: "skip" })).toBe("resolved");
    await expect(outcome).resolves.toEqual({
      action: "skip",
      reason: userSkipReason("create_widget"),
    });
  });

  it("resolves revise carrying the user's text", async () => {
    const decisions = new PendingDecisions();
    const { decisionId, outcome } = parkOn(decisions, "s1");

    expect(decisions.decide(decisionId, "s1", { action: "revise", text: "use p95" })).toBe(
      "resolved",
    );
    await expect(outcome).resolves.toEqual({ action: "revise", text: "use p95" });
  });

  it("returns unknown for a decisionId it has never seen", () => {
    const decisions = new PendingDecisions();
    expect(decisions.decide("nope", "s1", { action: "create" })).toBe("unknown");
  });

  it("returns unknown (and stays parked) when the sessionId does not match", () => {
    const decisions = new PendingDecisions();
    const { decisionId } = parkOn(decisions, "s1");

    expect(decisions.decide(decisionId, "other-session", { action: "create" })).toBe("unknown");
    expect(decisions.pendingCount()).toBe(1);
    decisions.releaseSession("s1", "cleanup");
  });

  it("reports already_decided on a double decide — first decision wins", async () => {
    const decisions = new PendingDecisions();
    const { decisionId, outcome } = parkOn(decisions, "s1");

    expect(decisions.decide(decisionId, "s1", { action: "create" })).toBe("resolved");
    expect(decisions.decide(decisionId, "s1", { action: "skip" })).toBe("already_decided");
    await expect(outcome).resolves.toEqual({ action: "create" });
  });

  it("times out a parked decision as skip after the backstop window", async () => {
    vi.useFakeTimers();
    const decisions = new PendingDecisions();
    const { decisionId, outcome } = parkOn(decisions, "s1");

    await vi.advanceTimersByTimeAsync(DECISION_TIMEOUT_MS);
    await expect(outcome).resolves.toEqual({
      action: "skip",
      reason: DECISION_TIMED_OUT_SKIP_REASON,
    });
    expect(decisions.pendingCount()).toBe(0);
    // Timed-out ids are expired, not decided: a late decide is a 404-shaped unknown.
    expect(decisions.decide(decisionId, "s1", { action: "create" })).toBe("unknown");
  });

  it("releaseSession resolves every parked decision for that session only", async () => {
    const decisions = new PendingDecisions();
    const a = parkOn(decisions, "s1");
    const b = parkOn(decisions, "s1");
    const other = parkOn(decisions, "s2");

    expect(decisions.releaseSession("s1", "the run ended")).toBe(2);
    await expect(a.outcome).resolves.toEqual({ action: "skip", reason: "the run ended" });
    await expect(b.outcome).resolves.toEqual({ action: "skip", reason: "the run ended" });
    expect(decisions.pendingCount()).toBe(1);
    expect(decisions.pendingCount("s2")).toBe(1);
    decisions.releaseSession("s2", "cleanup");
    void other;
  });

  it("heartbeats the session channel while a decision is parked, then stops", async () => {
    vi.useFakeTimers();
    const decisions = new PendingDecisions();
    const channel = channelFor("u1");
    decisions.registerChannel("s1", channel);
    const { decisionId } = parkOn(decisions, "s1");

    await vi.advanceTimersByTimeAsync(PARKED_HEARTBEAT_MS * 2);
    expect(channel.keepalive).toHaveBeenCalledTimes(2);

    decisions.decide(decisionId, "s1", { action: "create" });
    await vi.advanceTimersByTimeAsync(PARKED_HEARTBEAT_MS * 3);
    expect(channel.keepalive).toHaveBeenCalledTimes(2);
    decisions.unregisterChannel("s1", channel);
  });

  it("unregisterChannel removes only the matching channel instance", () => {
    const decisions = new PendingDecisions();
    const stale = channelFor("u1");
    const fresh = channelFor("u1");
    decisions.registerChannel("s1", stale);
    decisions.registerChannel("s1", fresh);

    decisions.unregisterChannel("s1", stale);
    expect(decisions.channelFor("s1")).toBe(fresh);
    decisions.unregisterChannel("s1", fresh);
    expect(decisions.channelFor("s1")).toBeUndefined();
  });
});

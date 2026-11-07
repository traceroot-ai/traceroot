import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DECISION_TIMEOUT_MS,
  DECISION_TIMED_OUT_SKIP_REASON,
  GLOBAL_PARK_LIMIT_REASON,
  MAX_PARKED_PER_SESSION,
  MAX_PARKED_TOTAL,
  PARKED_HEARTBEAT_MS,
  ParkRefusedError,
  PendingDecisions,
  SESSION_PARK_LIMIT_REASON,
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

  it("releaseSession resolves the parked decision for that session only", async () => {
    const decisions = new PendingDecisions();
    const a = parkOn(decisions, "s1");
    const other = parkOn(decisions, "s2");

    expect(decisions.releaseSession("s1", "the run ended")).toBe(1);
    await expect(a.outcome).resolves.toEqual({ action: "skip", reason: "the run ended" });
    expect(decisions.pendingCount()).toBe(1);
    expect(decisions.pendingCount("s2")).toBe(1);
    decisions.releaseSession("s2", "cleanup");
    void other;
  });

  describe("bounds", () => {
    it("refuses a second park for a session that already has one waiting, registering nothing", () => {
      const decisions = new PendingDecisions();
      const first = parkOn(decisions, "s1");
      expect(MAX_PARKED_PER_SESSION).toBe(1);

      expect(() => parkOn(decisions, "s1", "create_widget")).toThrow(ParkRefusedError);
      expect(() => parkOn(decisions, "s1", "create_widget")).toThrow(SESSION_PARK_LIMIT_REASON);
      expect(decisions.parkRefusal("s1")).toBe(SESSION_PARK_LIMIT_REASON);
      expect(decisions.pendingCount()).toBe(1);
      // Another session is unaffected by s1's bound.
      expect(decisions.parkRefusal("s2")).toBeNull();
      decisions.releaseDecision(first.decisionId, "cleanup");
    });

    it("frees the session's slot on resolve, and on the timeout backstop", async () => {
      vi.useFakeTimers();
      const decisions = new PendingDecisions();
      const first = parkOn(decisions, "s1");
      decisions.decide(first.decisionId, "s1", { action: "create" });
      await first.outcome;
      expect(decisions.parkRefusal("s1")).toBeNull();

      const second = parkOn(decisions, "s1");
      expect(decisions.parkRefusal("s1")).toBe(SESSION_PARK_LIMIT_REASON);
      await vi.advanceTimersByTimeAsync(DECISION_TIMEOUT_MS);
      await expect(second.outcome).resolves.toEqual({
        action: "skip",
        reason: DECISION_TIMED_OUT_SKIP_REASON,
      });
      expect(decisions.parkRefusal("s1")).toBeNull();
      expect(decisions.pendingCount()).toBe(0);
    });

    it("refuses any park once the service-wide cap is reached, until one is released", async () => {
      const decisions = new PendingDecisions();
      const parked = Array.from({ length: MAX_PARKED_TOTAL }, (_, i) =>
        parkOn(decisions, `session-${i}`),
      );
      expect(decisions.pendingCount()).toBe(MAX_PARKED_TOTAL);

      expect(() => parkOn(decisions, "one-more")).toThrow(GLOBAL_PARK_LIMIT_REASON);
      expect(decisions.parkRefusal("one-more")).toBe(GLOBAL_PARK_LIMIT_REASON);
      expect(decisions.pendingCount()).toBe(MAX_PARKED_TOTAL);

      decisions.releaseDecision(parked[0]!.decisionId, "cleanup");
      await parked[0]!.outcome;
      expect(decisions.parkRefusal("one-more")).toBeNull();
      expect(() => parkOn(decisions, "one-more")).not.toThrow();
      for (const session of [...parked.slice(1).map((_, i) => `session-${i + 1}`), "one-more"]) {
        decisions.releaseSession(session, "cleanup");
      }
      expect(decisions.pendingCount()).toBe(0);
    });
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

  it("keeps one session's decline out of another session's tool result", async () => {
    // The store is one process-wide singleton and tool-call ids come from the
    // provider — some number them per run, so two live sessions can hold the
    // same id. Keyed on the id alone, s2's tool result would consume s1's
    // decline and carry another user's revision text into its own stream.
    const decisions = new PendingDecisions();
    const s1 = parkOn(decisions, "s1");
    decisions.decide(s1.decisionId, "s1", { action: "revise", text: "internal token" });
    await s1.outcome;

    // Same tool-call id, different session.
    expect(decisions.takeDecline("s2", "tc-1")).toBeUndefined();
    // s1's own record is untouched and still consumable exactly once.
    expect(decisions.takeDecline("s1", "tc-1")).toEqual({
      kind: "proposal_declined",
      outcome: "revised",
      text: "internal token",
    });
  });

  it("takeDecline consumes the recorded decline exactly once", async () => {
    const decisions = new PendingDecisions();
    const { decisionId, outcome } = parkOn(decisions, "s1");
    decisions.decide(decisionId, "s1", { action: "skip" });
    await outcome;

    expect(decisions.takeDecline("s1", "tc-1")).toEqual({
      kind: "proposal_declined",
      outcome: "skipped",
    });
    expect(decisions.takeDecline("s1", "tc-1")).toBeUndefined();
  });

  it("records a skipped decline for internal release paths too (timeout, run end)", async () => {
    const decisions = new PendingDecisions();
    const { outcome } = parkOn(decisions, "s1");
    decisions.releaseSession("s1", "run ended");
    await outcome;

    expect(decisions.takeDecline("s1", "tc-1")).toEqual({
      kind: "proposal_declined",
      outcome: "skipped",
    });
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

describe("approval-class parks", () => {
  it("settles a revise on an approval-class park as a skip, recording no revision text", async () => {
    const decisions = new PendingDecisions();
    decisions.registerChannel("s1", channelFor("u1"));
    const { decisionId, outcome } = decisions.park({
      sessionId: "s1",
      toolCallId: "tc-9",
      toolName: "delete_widget",
      args: { widget_id: "w1", reason: "asked to remove it" },
      approvalClass: "approval",
    });
    expect(decisions.decide(decisionId, "s1", { action: "revise", text: "remove both" })).toBe(
      "resolved",
    );
    await expect(outcome).resolves.toEqual({
      action: "skip",
      reason: userSkipReason("delete_widget"),
    });
    expect(decisions.takeDecline("s1", "tc-9")).toEqual({
      kind: "proposal_declined",
      outcome: "skipped",
    });
  });

  it("still lets a confirm-class park (the default) resolve a revise as a revision", async () => {
    const decisions = new PendingDecisions();
    decisions.registerChannel("s1", channelFor("u1"));
    const { decisionId, outcome } = parkOn(decisions, "s1");
    decisions.decide(decisionId, "s1", { action: "revise", text: "use p95" });
    await expect(outcome).resolves.toEqual({ action: "revise", text: "use p95" });
  });
});

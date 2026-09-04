import { describe, expect, it, vi } from "vitest";
import type { BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import {
  APPROVAL_REQUIRED_REASON,
  CONFIRMATION_UNAVAILABLE_REASON,
  createWritePolicyHook,
  writePolicyHook,
} from "../write-policy.js";
import {
  PendingDecisions,
  revisionReason,
  userSkipReason,
  type ConfirmationPendingEvent,
} from "../../pending-decisions.js";

function contextFor(toolName: string, args: unknown = {}): BeforeToolCallContext {
  return {
    toolCall: { type: "toolCall", id: `call-${toolName}`, name: toolName, arguments: args },
    args,
  } as unknown as BeforeToolCallContext;
}

const CONFIRM_ENTRY = {
  name: "create_detector",
  policy: { approvalClass: "confirm", minRole: "MEMBER", tenancy: "project" },
} as const;

/** A registry with an attended (or unattended) channel registered for s1. */
function attendedSetup(userId = "u1") {
  const decisions = new PendingDecisions();
  const emitted: ConfirmationPendingEvent[] = [];
  decisions.registerChannel("s1", {
    userId,
    emit: (event) => emitted.push(event),
    keepalive: vi.fn(),
  });
  const hook = createWritePolicyHook([CONFIRM_ENTRY], { sessionId: "s1", decisions });
  return { decisions, emitted, hook };
}

/** Watch settlement without awaiting: parked hooks must NOT settle on their own. */
function settlement<T>(promise: Promise<T>): { settled: () => boolean } {
  let settled = false;
  void promise.finally(() => {
    settled = true;
  });
  return { settled: () => settled };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("writePolicyHook", () => {
  it("lets tools without a registry policy proceed (read, sandbox, github)", async () => {
    for (const name of ["list_traces", "bash", "git_clone", "not_a_registered_tool"]) {
      await expect(writePolicyHook(contextFor(name))).resolves.toBeUndefined();
    }
  });

  it('lets writes with approvalClass "none" proceed', async () => {
    const hook = createWritePolicyHook([
      {
        name: "touch_nothing",
        policy: { approvalClass: "none", minRole: "MEMBER", tenancy: "project" },
      },
    ]);
    await expect(hook(contextFor("touch_nothing"))).resolves.toBeUndefined();
  });

  it('blocks approvalClass "confirm" saying confirmation is not wired up yet', async () => {
    const hook = createWritePolicyHook([
      {
        name: "create_detector",
        policy: { approvalClass: "confirm", minRole: "MEMBER", tenancy: "project" },
      },
    ]);
    await expect(hook(contextFor("create_detector"))).resolves.toEqual({
      block: true,
      reason: CONFIRMATION_UNAVAILABLE_REASON,
    });
  });

  it('blocks the five registry creates (now "confirm") with the confirmation reason', async () => {
    // All five curated creates carry approvalClass "confirm" in the registry.
    for (const name of ["create_workspace", "create_detector", "create_widget"]) {
      await expect(writePolicyHook(contextFor(name))).resolves.toEqual({
        block: true,
        reason: CONFIRMATION_UNAVAILABLE_REASON,
      });
    }
  });

  it('blocks approvalClass "approval" with the fail-closed reason', async () => {
    const hook = createWritePolicyHook([
      { name: "list_traces" },
      {
        name: "delete_detector",
        policy: { approvalClass: "approval", minRole: "MEMBER", tenancy: "project" },
      },
    ]);
    await expect(hook(contextFor("delete_detector"))).resolves.toEqual({
      block: true,
      reason: APPROVAL_REQUIRED_REASON,
    });
    // The read entry in the same list still proceeds.
    await expect(hook(contextFor("list_traces"))).resolves.toBeUndefined();
  });

  it("blocks a session-bound confirm hook when no run channel is registered", async () => {
    // A confirm call outside a live streaming run has nobody to ask — fail closed.
    const hook = createWritePolicyHook([CONFIRM_ENTRY], {
      sessionId: "s1",
      decisions: new PendingDecisions(),
    });
    await expect(hook(contextFor("create_detector"))).resolves.toEqual({
      block: true,
      reason: CONFIRMATION_UNAVAILABLE_REASON,
    });
  });

  it("blocks unknown future approval classes fail-closed, not just the known ones", async () => {
    const hook = createWritePolicyHook([
      {
        name: "purge_everything",
        policy: {
          approvalClass: "some_future_class" as never,
          minRole: "ADMIN",
          tenancy: "workspace",
        },
      },
    ]);
    await expect(hook(contextFor("purge_everything"))).resolves.toEqual({
      block: true,
      reason: APPROVAL_REQUIRED_REASON,
    });
  });
});

describe("writePolicyHook — parked confirmations", () => {
  it("parks an attended confirm call: emits confirmation_pending and does not settle", async () => {
    const { decisions, emitted, hook } = attendedSetup();
    const parked = settlement(hook(contextFor("create_detector", { name: "latency" })));

    await tick();
    expect(parked.settled()).toBe(false);
    expect(decisions.pendingCount("s1")).toBe(1);
    expect(emitted).toEqual([
      {
        type: "confirmation_pending",
        decisionId: expect.any(String),
        toolCallId: "call-create_detector",
        toolName: "create_detector",
        args: { name: "latency" },
      },
    ]);
    decisions.releaseSession("s1", "cleanup");
  });

  it("create → the call proceeds unchanged (hook resolves undefined)", async () => {
    const { decisions, emitted, hook } = attendedSetup();
    const result = hook(contextFor("create_detector"));
    await tick();
    decisions.decide(emitted[0].decisionId, "s1", { action: "create" });
    await expect(result).resolves.toBeUndefined();
    expect(decisions.pendingCount()).toBe(0);
  });

  it("skip → declined result leads with NOT executed and instructs no retry", async () => {
    const { decisions, emitted, hook } = attendedSetup();
    const result = hook(contextFor("create_detector"));
    await tick();
    decisions.decide(emitted[0].decisionId, "s1", { action: "skip" });
    await expect(result).resolves.toEqual({
      block: true,
      reason: userSkipReason("create_detector"),
    });
    // Pinned literally: any model must be able to read non-execution from the
    // text alone, before anything else in the result.
    expect(userSkipReason("create_detector")).toBe(
      "This create_detector call was NOT executed — the user chose to skip it. " +
        "Do not retry it; acknowledge the skip and continue.",
    );
    expect(decisions.pendingCount()).toBe(0);
  });

  it("skip → records proposal_declined details for the surfaced result", async () => {
    const { decisions, emitted, hook } = attendedSetup();
    const result = hook(contextFor("create_detector"));
    await tick();
    decisions.decide(emitted[0].decisionId, "s1", { action: "skip" });
    await result;
    expect(decisions.takeDecline("call-create_detector")).toEqual({
      kind: "proposal_declined",
      outcome: "skipped",
    });
  });

  it("revise → declined result leads with NOT executed and instructs a re-proposal", async () => {
    const { decisions, emitted, hook } = attendedSetup();
    const result = hook(contextFor("create_detector"));
    await tick();
    decisions.decide(emitted[0].decisionId, "s1", { action: "revise", text: "use p95 latency" });
    await expect(result).resolves.toEqual({
      block: true,
      reason: revisionReason("use p95 latency"),
    });
    expect(revisionReason("use p95 latency")).toBe(
      "This tool call was NOT executed. The user wants changes: use p95 latency\n" +
        "Propose the call again with those changes applied.",
    );
  });

  it("revise → records proposal_declined details carrying the user's text", async () => {
    const { decisions, emitted, hook } = attendedSetup();
    const result = hook(contextFor("create_detector"));
    await tick();
    decisions.decide(emitted[0].decisionId, "s1", { action: "revise", text: "use p95 latency" });
    await result;
    expect(decisions.takeDecline("call-create_detector")).toEqual({
      kind: "proposal_declined",
      outcome: "revised",
      text: "use p95 latency",
    });
  });

  it("create → records no decline details", async () => {
    const { decisions, emitted, hook } = attendedSetup();
    const result = hook(contextFor("create_detector"));
    await tick();
    decisions.decide(emitted[0].decisionId, "s1", { action: "create" });
    await result;
    expect(decisions.takeDecline("call-create_detector")).toBeUndefined();
  });

  it("unattended session (channel without userId) executes confirm immediately, no event", async () => {
    const { decisions, emitted, hook } = attendedSetup("");
    await expect(hook(contextFor("create_detector"))).resolves.toBeUndefined();
    expect(emitted).toEqual([]);
    expect(decisions.pendingCount()).toBe(0);
  });

  it("does not leak the parked decision when emitting the event throws", async () => {
    const decisions = new PendingDecisions();
    decisions.registerChannel("s1", {
      userId: "u1",
      emit: () => {
        throw new Error("stream gone");
      },
      keepalive: vi.fn(),
    });
    const hook = createWritePolicyHook([CONFIRM_ENTRY], { sessionId: "s1", decisions });
    await expect(hook(contextFor("create_detector"))).resolves.toEqual({
      block: true,
      reason: CONFIRMATION_UNAVAILABLE_REASON,
    });
    expect(decisions.pendingCount()).toBe(0);
  });
});

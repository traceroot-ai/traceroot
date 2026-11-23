import { describe, expect, it, vi } from "vitest";
import type { BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import {
  APPROVAL_REQUIRED_REASON,
  CONFIRMATION_UNAVAILABLE_REASON,
  createWritePolicyHook,
} from "../write-policy.js";
import {
  PendingDecisions,
  SESSION_PARK_LIMIT_REASON,
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

const APPROVAL_ENTRY = {
  name: "delete_detector",
  policy: { approvalClass: "approval", minRole: "MEMBER", tenancy: "project" },
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
  const hook = createWritePolicyHook([CONFIRM_ENTRY, APPROVAL_ENTRY], {
    sessionId: "s1",
    decisions,
  });
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

/** The shared-registry hook built without a session: it has nothing to park on. */
const sessionlessHook = createWritePolicyHook();

describe("createWritePolicyHook", () => {
  it("lets tools without a registry policy proceed (read, sandbox, github)", async () => {
    for (const name of ["list_traces", "bash", "git_clone", "not_a_registered_tool"]) {
      await expect(sessionlessHook(contextFor(name))).resolves.toBeUndefined();
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

  it('blocks approvalClass "confirm" when the hook has no session channel to park on', async () => {
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

  it("fails the agent-bound registry creates closed on a session-less hook (nothing to park on)", async () => {
    // The registry creates carry approvalClass "confirm"; without a session
    // channel there is no user to ask, so they block instead of parking.
    for (const name of ["create_detector", "create_dashboard", "create_widget", "create_alert"]) {
      await expect(sessionlessHook(contextFor(name))).resolves.toEqual({
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

describe("createWritePolicyHook — parked confirmations", () => {
  it("parks create_alert on the shared registry's own policy, like the other creates", async () => {
    // Built on the real registry, not CONFIRM_ENTRY: the test is that the
    // generated policy for create_alert is confirm-class, so an alert proposal
    // lands on a confirmation card instead of running or being blocked.
    const decisions = new PendingDecisions();
    const emitted: ConfirmationPendingEvent[] = [];
    decisions.registerChannel("s1", {
      userId: "u1",
      emit: (event) => emitted.push(event),
      keepalive: vi.fn(),
    });
    const hook = createWritePolicyHook(undefined, { sessionId: "s1", decisions });
    const args = { name: "p95 latency", measure: "latency", threshold: 2000 };
    const parked = settlement(hook(contextFor("create_alert", args)));
    await tick();
    expect(parked.settled()).toBe(false);
    expect(emitted).toEqual([
      expect.objectContaining({
        type: "confirmation_pending",
        toolName: "create_alert",
        toolCallId: "call-create_alert",
        args,
      }),
    ]);
  });

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
        approvalClass: "confirm",
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
    expect(decisions.takeDecline("s1", "call-create_detector")).toEqual({
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
    expect(decisions.takeDecline("s1", "call-create_detector")).toEqual({
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
    expect(decisions.takeDecline("s1", "call-create_detector")).toBeUndefined();
  });

  it("fails closed with the registry's reason when the session already has a parked proposal", async () => {
    const { decisions, emitted, hook } = attendedSetup();
    const first = hook(contextFor("create_detector"));
    await tick();
    expect(emitted).toHaveLength(1);

    // A second confirm call while the first is still parked: not parked, no
    // card, and the tool result says why — the first proposal stays parked.
    await expect(hook(contextFor("create_detector", { name: "second" }))).resolves.toEqual({
      block: true,
      reason: SESSION_PARK_LIMIT_REASON,
    });
    expect(emitted).toHaveLength(1);
    expect(decisions.pendingCount("s1")).toBe(1);

    decisions.decide(emitted[0].decisionId, "s1", { action: "create" });
    await expect(first).resolves.toBeUndefined();
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

describe("createWritePolicyHook — approval class (deletes)", () => {
  const deleteArgs = { detector_id: "d1", reason: "the user asked to remove the duplicate" };

  it("parks delete_detector on the shared registry's own policy, as approval-class", async () => {
    const decisions = new PendingDecisions();
    const emitted: ConfirmationPendingEvent[] = [];
    decisions.registerChannel("s1", {
      userId: "u1",
      emit: (event) => emitted.push(event),
      keepalive: vi.fn(),
    });
    const hook = createWritePolicyHook(undefined, { sessionId: "s1", decisions });
    const parked = settlement(hook(contextFor("delete_detector", deleteArgs)));
    await tick();
    expect(parked.settled()).toBe(false);
    expect(emitted).toEqual([
      expect.objectContaining({
        type: "confirmation_pending",
        toolName: "delete_detector",
        args: deleteArgs,
        approvalClass: "approval",
      }),
    ]);
    decisions.releaseSession("s1", "cleanup");
  });

  it("parks an attended approval call with the reason on the event, and does not settle", async () => {
    const { decisions, emitted, hook } = attendedSetup();
    const parked = settlement(hook(contextFor("delete_detector", deleteArgs)));

    await tick();
    expect(parked.settled()).toBe(false);
    expect(decisions.pendingCount("s1")).toBe(1);
    expect(emitted).toEqual([
      {
        type: "confirmation_pending",
        decisionId: expect.any(String),
        toolCallId: "call-delete_detector",
        toolName: "delete_detector",
        args: deleteArgs,
        approvalClass: "approval",
      },
    ]);
    decisions.releaseSession("s1", "cleanup");
  });

  it("create → the delete proceeds unchanged", async () => {
    const { decisions, emitted, hook } = attendedSetup();
    const result = hook(contextFor("delete_detector", deleteArgs));
    await tick();
    decisions.decide(emitted[0].decisionId, "s1", { action: "create" });
    await expect(result).resolves.toBeUndefined();
  });

  it("skip → the declined result says the delete was NOT executed", async () => {
    const { decisions, emitted, hook } = attendedSetup();
    const result = hook(contextFor("delete_detector", deleteArgs));
    await tick();
    decisions.decide(emitted[0].decisionId, "s1", { action: "skip" });
    await expect(result).resolves.toEqual({
      block: true,
      reason: userSkipReason("delete_detector"),
    });
    expect(decisions.takeDecline("s1", "call-delete_detector")).toEqual({
      kind: "proposal_declined",
      outcome: "skipped",
    });
  });

  it("revise → resolves as a skip: there is no revise-by-typing for a delete", async () => {
    const { decisions, emitted, hook } = attendedSetup();
    const result = hook(contextFor("delete_detector", deleteArgs));
    await tick();
    decisions.decide(emitted[0].decisionId, "s1", { action: "revise", text: "delete both" });
    await expect(result).resolves.toEqual({
      block: true,
      reason: userSkipReason("delete_detector"),
    });
    // The decline is recorded as a skip, carrying no revision text the model
    // could act on as a re-proposal.
    expect(decisions.takeDecline("s1", "call-delete_detector")).toEqual({
      kind: "proposal_declined",
      outcome: "skipped",
    });
  });

  it("unattended session (channel without userId) blocks an approval call fail-closed, no event", async () => {
    // Unlike confirm, which executes as none when nobody is there: a system
    // or RCA session never deletes.
    const { decisions, emitted, hook } = attendedSetup("");
    await expect(hook(contextFor("delete_detector", deleteArgs))).resolves.toEqual({
      block: true,
      reason: APPROVAL_REQUIRED_REASON,
    });
    expect(emitted).toEqual([]);
    expect(decisions.pendingCount()).toBe(0);
  });

  it("blocks a session-bound approval call when no run channel is registered", async () => {
    const hook = createWritePolicyHook([APPROVAL_ENTRY], {
      sessionId: "s1",
      decisions: new PendingDecisions(),
    });
    await expect(hook(contextFor("delete_detector", deleteArgs))).resolves.toEqual({
      block: true,
      reason: APPROVAL_REQUIRED_REASON,
    });
  });

  it("fails closed with the registry's reason when the session already has a parked proposal", async () => {
    const { decisions, emitted, hook } = attendedSetup();
    const first = hook(contextFor("create_detector"));
    await tick();
    await expect(hook(contextFor("delete_detector", deleteArgs))).resolves.toEqual({
      block: true,
      reason: SESSION_PARK_LIMIT_REASON,
    });
    expect(emitted).toHaveLength(1);
    decisions.decide(emitted[0].decisionId, "s1", { action: "create" });
    await expect(first).resolves.toBeUndefined();
  });

  it("does not leak the parked approval when emitting the event throws", async () => {
    const decisions = new PendingDecisions();
    decisions.registerChannel("s1", {
      userId: "u1",
      emit: () => {
        throw new Error("stream gone");
      },
      keepalive: vi.fn(),
    });
    const hook = createWritePolicyHook([APPROVAL_ENTRY], { sessionId: "s1", decisions });
    await expect(hook(contextFor("delete_detector", deleteArgs))).resolves.toEqual({
      block: true,
      reason: CONFIRMATION_UNAVAILABLE_REASON,
    });
    expect(decisions.pendingCount()).toBe(0);
  });
});

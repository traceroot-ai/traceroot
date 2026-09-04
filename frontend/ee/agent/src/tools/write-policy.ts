import type { BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import { REGISTRY, type RegistryEntry } from "@traceroot-ai/tools";
import { pendingDecisions, revisionReason, type PendingDecisions } from "../pending-decisions.js";

/** The name→policy slice of a registry entry the hook needs. */
type PolicyCarrier = Pick<RegistryEntry, "name" | "policy">;

export const APPROVAL_REQUIRED_REASON =
  "This operation requires human approval, which is not yet available in this chat. It was not performed.";

export const CONFIRMATION_UNAVAILABLE_REASON =
  "This operation asks the user to confirm before it runs, and no confirmation flow is available here. It was not performed.";

export interface WritePolicyHookOptions {
  /** The conversation session the hook's agent belongs to. */
  sessionId?: string;
  /** Decision registry override for tests; defaults to the service singleton. */
  decisions?: PendingDecisions;
}

/**
 * Build a beforeToolCall hook enforcing the registry's write policies.
 *
 * Policy gate: only tools whose registry entry carries `approvalClass:
 * "none"` may execute unconditionally. `"confirm"` writes PARK: in an
 * attended session (the live run's channel carries a userId) the hook emits
 * a `confirmation_pending` SSE event and waits for the user's decision —
 * create lets the call run unchanged, skip/revise decline it with a reason
 * the model narrates, and every release path (run error, run end, client
 * disconnect, session deletion, timeout) resolves the wait as a skip so a
 * parked call can never hold the turn open forever. An unattended/system
 * session has nobody to ask, so confirm executes as "none"; a confirm call
 * with no live channel at all fails closed. Any other approval class
 * (including unknown future ones) is blocked as requiring approval. Tools
 * without a policy entry (read tools, sandbox tools, github tools — anything
 * not a registry write) proceed untouched. The hook never throws.
 */
export function createWritePolicyHook(
  entries: readonly PolicyCarrier[] = REGISTRY,
  options: WritePolicyHookOptions = {},
): (
  context: BeforeToolCallContext,
  signal?: AbortSignal,
) => Promise<BeforeToolCallResult | undefined> {
  const policies = new Map(
    entries.flatMap((entry) => (entry.policy ? [[entry.name, entry.policy] as const] : [])),
  );

  return async (context) => {
    const policy = policies.get(context.toolCall.name);
    if (policy === undefined || policy.approvalClass === "none") {
      return undefined;
    }
    if (policy.approvalClass === "confirm") {
      return awaitConfirmation(context, options);
    }
    return { block: true, reason: APPROVAL_REQUIRED_REASON };
  };
}

/** Park a confirm-class call until the user decides (see createWritePolicyHook). */
async function awaitConfirmation(
  context: BeforeToolCallContext,
  options: WritePolicyHookOptions,
): Promise<BeforeToolCallResult | undefined> {
  const decisions = options.decisions ?? pendingDecisions;
  const channel = options.sessionId ? decisions.channelFor(options.sessionId) : undefined;
  if (!channel) {
    return { block: true, reason: CONFIRMATION_UNAVAILABLE_REASON };
  }
  if (!channel.userId) {
    // Unattended/system session: nobody is there to confirm — run as "none".
    return undefined;
  }

  const toolName = context.toolCall.name;
  const { decisionId, outcome } = decisions.park({
    sessionId: options.sessionId!,
    toolCallId: context.toolCall.id,
    toolName,
    args: context.args,
  });
  try {
    channel.emit({
      type: "confirmation_pending",
      decisionId,
      toolCallId: context.toolCall.id,
      toolName,
      args: context.args,
    });
  } catch (error) {
    // The user can never see a card we failed to send — release the parked
    // promise immediately instead of waiting out the timeout backstop.
    console.error(`[Agent] Failed to emit confirmation_pending for ${toolName}:`, error);
    decisions.releaseDecision(decisionId, CONFIRMATION_UNAVAILABLE_REASON);
  }

  const decision = await outcome;
  if (decision.action === "create") {
    return undefined;
  }
  if (decision.action === "revise") {
    return { block: true, reason: revisionReason(decision.text) };
  }
  return { block: true, reason: decision.reason };
}

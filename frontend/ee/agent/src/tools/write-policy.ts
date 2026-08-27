import type { BeforeToolCallContext, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import { REGISTRY, type RegistryEntry } from "@traceroot-ai/tools";

/** The name→policy slice of a registry entry the hook needs. */
type PolicyCarrier = Pick<RegistryEntry, "name" | "policy">;

export const APPROVAL_REQUIRED_REASON =
  "This operation requires human approval, which is not yet available in this chat. It was not performed.";

/**
 * Build a beforeToolCall hook enforcing the registry's write policies.
 *
 * Fail-closed: only tools whose registry entry carries `approvalClass:
 * "none"` may execute; any other approval class is blocked until an approval
 * flow exists in this surface. Tools without a policy entry (read tools,
 * sandbox tools, github tools — anything not a registry write) proceed
 * untouched. The hook never throws.
 */
export function createWritePolicyHook(
  entries: readonly PolicyCarrier[] = REGISTRY,
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
    return { block: true, reason: APPROVAL_REQUIRED_REASON };
  };
}

/** The hook instance the agent registers — built once from the shared registry. */
export const writePolicyHook = createWritePolicyHook();

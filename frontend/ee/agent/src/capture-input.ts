import { REGISTRY } from "@traceroot-ai/tools";

/**
 * Tools whose output the capture policy keeps because the agent vouches for
 * it: the registry's write tools (`create_alert`, `create_dashboard`, …).
 * Their result is the resource the TraceRoot API returned — the customer's
 * own data, the same class as `download_traces` — and the session rebuild
 * (`restoreToolStep`) and the chat cards read the outcome back from the
 * stored row: the created resource's id and name, or a declined proposal.
 * Withholding it would make a reloaded chat forget what it created. The
 * registry's read tools stay under the policy's own allow-list: their output
 * is only ever shown live, and nothing is rebuilt from it.
 */
const KEPT_OUTPUT_TOOLS: ReadonlySet<string> = new Set(
  REGISTRY.filter((e) => e.method !== "get").map((e) => e.name),
);

/** The capture policy's input for one tool call, with the agent's own allow-list applied. */
export function agentCaptureInput(
  toolName: string,
  args: unknown,
  result: unknown,
): { toolName: string; args: unknown; result: unknown; keepOutput?: boolean } {
  return {
    toolName,
    args,
    result,
    ...(KEPT_OUTPUT_TOOLS.has(toolName) ? { keepOutput: true } : {}),
  };
}

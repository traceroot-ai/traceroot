import { REGISTRY } from "@traceroot-ai/tools";

/**
 * Tools whose output the capture policy keeps because the agent vouches for
 * it: the registry's write tools (`create_alert`, `create_dashboard`, … —
 * the entries whose approval policy gates them, not every non-GET route).
 * Their result is the resource the TraceRoot API returned — the customer's
 * own data, the same class as `download_traces` — and the session rebuild
 * (`restoreToolStep`) and the chat cards read the outcome back from the
 * stored row: the created resource's id and name, or a declined proposal.
 * Withholding it would make a reloaded chat forget what it created. The
 * registry's read tools stay under the policy's own allow-list: their output
 * is only ever shown live, and nothing is rebuilt from it — except the card
 * details a history row keeps for the reads the panel draws (see
 * persistedCaptureInput).
 */
const KEPT_OUTPUT_TOOLS: ReadonlySet<string> = new Set(
  // A write is what the registry's approval policy gates, not what the HTTP
  // method says: `run_widget_query` is a POST that only reads.
  REGISTRY.filter((e) => e.policy !== undefined && e.policy.approvalClass !== "none").map(
    (e) => e.name,
  ),
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

/**
 * Reads the chat panel draws as cards: each attaches a compact projection of
 * its payload as `details` beside the text the model reads (see
 * alert-card-details.ts and dashboard-card-details.ts).
 */
const CARD_READ_TOOLS: ReadonlySet<string> = new Set([
  "list_alerts",
  "get_alert",
  "get_dashboard",
  "get_dashboard_data",
  "get_widget",
  "get_widget_data",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The capture input for a chat history row. As agentCaptureInput, except a
 * card read keeps its card `details` and nothing else, so a reloaded chat
 * draws the same card the live stream did. The text the model read stays
 * out of the row, as every read's output does: the details are the compact
 * projection the card needs (ids, titles, specs, placements, status, the
 * window), never rows. Only the history row takes this: span capture and
 * the model's own context keep agentCaptureInput.
 */
export function persistedCaptureInput(
  toolName: string,
  args: unknown,
  result: unknown,
): ReturnType<typeof agentCaptureInput> {
  const base = agentCaptureInput(toolName, args, result);
  if (base.keepOutput === true || !CARD_READ_TOOLS.has(toolName)) return base;
  const details = isRecord(result) && isRecord(result.details) ? result.details : undefined;
  if (details === undefined) return base;
  return { toolName, args, result: { details }, keepOutput: true };
}

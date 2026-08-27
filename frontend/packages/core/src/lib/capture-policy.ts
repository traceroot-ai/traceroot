/**
 * One policy for what tool I/O may be persisted — used by the agent's StreamPersister
 * (ai_messages.tool_step rows) and by the SDK's captureToolIo hook (spans), so both
 * stores hold exactly the same content. Order matters: redact, then allowlist, then
 * truncate, then budget — truncating first could split a token and defeat a pattern.
 */
export interface CaptureBudget {
  perStepBytes: number;
  perRunBytes: number;
}
export const DEFAULT_CAPTURE_BUDGET: CaptureBudget = { perStepBytes: 8_192, perRunBytes: 262_144 };

/** Tools whose output is data the customer already owns inside TraceRoot. */
export const OUTPUT_ALLOWLIST: ReadonlySet<string> = new Set([
  "download_traces",
  "download_session",
  "submit_result",
]);

const PATTERNS: Array<[RegExp, string]> = [
  [/\b(gh[pousr]_)[A-Za-z0-9]{20,}/g, "$1[REDACTED]"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "sk-[REDACTED]"],
  [/\bAKIA[0-9A-Z]{12,}/g, "AKIA[REDACTED]"],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, "$1[REDACTED]"],
  [/\b([A-Z][A-Z0-9_]{2,}(?:KEY|TOKEN|SECRET|PASSWORD))=([^\s'"]+)/g, "$1=[REDACTED]"],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v)]),
    );
  }
  return value;
}

function toText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function truncateTo(text: string, bytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= bytes) return { text, truncated: false };
  return { text: buf.subarray(0, bytes).toString("utf8") + "…", truncated: true };
}

export function applyCapturePolicy(
  input: { toolName: string; args: unknown; result: unknown },
  state: { spentBytes: number },
  budget: CaptureBudget = DEFAULT_CAPTURE_BUDGET,
): {
  args: unknown;
  result?: string;
  outputBytes: number;
  truncated: boolean;
  withheld: "not-allowlisted" | "budget" | null;
} {
  const args = redactDeep(input.args);
  const raw = toText(input.result);
  const outputBytes = Buffer.byteLength(raw, "utf8");
  if (!OUTPUT_ALLOWLIST.has(input.toolName)) {
    return { args, outputBytes, truncated: false, withheld: "not-allowlisted" };
  }
  if (state.spentBytes >= budget.perRunBytes) {
    return { args, outputBytes, truncated: false, withheld: "budget" };
  }
  const { text, truncated } = truncateTo(redactSecrets(raw), budget.perStepBytes);
  state.spentBytes += Buffer.byteLength(text, "utf8");
  return { args, result: text, outputBytes, truncated, withheld: null };
}

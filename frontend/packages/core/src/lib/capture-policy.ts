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

const PATTERNS: Array<[RegExp, string | ((...args: never[]) => string)]> = [
  [/\b(gh[pousr]_)[A-Za-z0-9]{20,}/g, "$1[REDACTED]"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "sk-[REDACTED]"],
  [/\bAKIA[0-9A-Z]{12,}/g, "AKIA[REDACTED]"],
  // Case-insensitive: an `authorization: bearer …` header is as much a
  // credential as `Bearer …`, and tools echo headers in whatever case they got.
  [/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[REDACTED]"],
  // Assignment form, e.g. `API_KEY=…`, `token=…`, `db_password=…`. Case-
  // insensitive, and the name need not be prefixed: an earlier version required
  // three leading uppercase characters, which let bare `TOKEN=`, `PASSWORD=`
  // and lowercase `api_key=` through — the most common shapes in a .env file
  // or a printed environment.
  // The name is either the bare word or ends with `_word`, so `monkey=` and
  // `token_count=` stay readable while `api_key=` and `DB_PASSWORD=` do not.
  [
    /\b([A-Za-z0-9]+(?:_[A-Za-z0-9]+)*_)?(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)\s*=\s*[^\s'"]+/gi,
    (_m: string, prefix: string | undefined, word: string) => `${prefix ?? ""}${word}=[REDACTED]`,
  ],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, rep] of PATTERNS)
    out = out.replace(re, rep as string & ((...a: never[]) => string));
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

/** The marker appended to a truncated capture; it is charged to the budget too. */
const TRUNCATION_MARKER = "…";
const TRUNCATION_MARKER_BYTES = Buffer.byteLength(TRUNCATION_MARKER, "utf8");

/**
 * Cut `text` so the RESULT — marker included — fits in `bytes`. Reserving the
 * marker is what keeps a budget an actual ceiling: appending it after cutting
 * to the limit puts every truncated capture a few bytes over.
 */
function truncateTo(text: string, bytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= bytes) return { text, truncated: false };
  // Too little room for the marker itself: keep nothing rather than emit a
  // marker that would put the result over the allowance it is bounded by.
  if (bytes < TRUNCATION_MARKER_BYTES) return { text: "", truncated: true };
  const room = bytes - TRUNCATION_MARKER_BYTES;
  return { text: buf.subarray(0, room).toString("utf8") + TRUNCATION_MARKER, truncated: true };
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
  // Args are captured for every tool, so they are the one thing every step
  // writes — and a `write` call carries its whole file body in them. Bound and
  // charge them like output, or the budgets only govern the smaller half.
  // One step allowance, shared by the args and the result below.
  const step = { remaining: budget.perStepBytes };
  const args = capArgs(redactDeep(input.args), state, budget, step);
  const raw = toText(input.result);
  const outputBytes = Buffer.byteLength(raw, "utf8");
  if (!OUTPUT_ALLOWLIST.has(input.toolName)) {
    return { args, outputBytes, truncated: false, withheld: "not-allowlisted" };
  }
  const remaining = budget.perRunBytes - state.spentBytes;
  if (remaining <= 0) {
    return { args, outputBytes, truncated: false, withheld: "budget" };
  }
  // Never spend past the run budget: the last step gets what is left, not a
  // full step on top of an almost-exhausted budget.
  const { text, truncated } = truncateTo(redactSecrets(raw), Math.min(step.remaining, remaining));
  state.spentBytes += Buffer.byteLength(text, "utf8");
  return { args, result: text, outputBytes, truncated, withheld: null };
}

/**
 * Bound captured args against the same budgets as output, charging what is
 * kept. Serialising once and truncating the JSON would produce unparseable
 * metadata, so each string leaf is capped instead and the structure survives.
 */
function capArgs(
  args: unknown,
  state: { spentBytes: number },
  budget: CaptureBudget,
  step: { remaining: number },
): unknown {
  const cap = (value: unknown): unknown => {
    if (typeof value === "string") {
      // Both budgets bind: the step's remaining allowance is shared across every
      // leaf (a per-leaf cap would let an args object with many strings exceed
      // perStepBytes by a multiple of its leaf count), and the run's total is
      // the hard ceiling.
      const remaining = Math.min(step.remaining, budget.perRunBytes - state.spentBytes);
      if (remaining <= 0) return "[withheld: budget]";
      const { text } = truncateTo(value, remaining);
      const spent = Buffer.byteLength(text, "utf8");
      state.spentBytes += spent;
      step.remaining -= spent;
      return text;
    }
    if (Array.isArray(value)) return value.map(cap);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, cap(v)]),
      );
    }
    return value;
  };
  return cap(args);
}

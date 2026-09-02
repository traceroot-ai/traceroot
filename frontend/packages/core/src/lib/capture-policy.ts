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
const DEFAULT_CAPTURE_BUDGET: CaptureBudget = { perStepBytes: 8_192, perRunBytes: 262_144 };

/** Tools whose output is data the customer already owns inside TraceRoot. */
const OUTPUT_ALLOWLIST: ReadonlySet<string> = new Set([
  "download_traces",
  "download_session",
  "submit_result",
]);

// A credential name is the bare word or ends with `_word`, so `monkey=` and
// `token_count=` stay readable while `api_key=` and `DB_PASSWORD=` do not.
// Known false positives, accepted for the sake of a short pattern: `sort_key=`,
// `primary_key=` and a URL's `?key=` are redacted too (display only — tool_step
// rows are never fed back to the model, see SessionManager.buildContext).
const SECRET_NAME =
  "([A-Za-z0-9]+(?:_[A-Za-z0-9]+)*_)?(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)";
// A value is a double- or single-quoted string, or a run of non-space characters.
// `.env` files and shell exports are usually quoted, and a JSON-stringified
// result always is; an earlier version stopped at the opening quote and let
// `PASSWORD="…"` through.
const SECRET_VALUE = `(?:"[^"]*"|'[^']*'|[^\\s"',}]+)`;

const PATTERNS: Array<[RegExp, string | ((...args: never[]) => string)]> = [
  [/\b(gh[pousr]_)[A-Za-z0-9]{20,}/g, "$1[REDACTED]"],
  // OpenAI-style `sk-…` and Stripe `sk_live_…` / `sk_test_…`.
  [/\b(sk[-_](?:live_|test_)?)[A-Za-z0-9_-]{16,}/g, "$1[REDACTED]"],
  [/\bAKIA[0-9A-Z]{12,}/g, "AKIA[REDACTED]"],
  // Case-insensitive: an `authorization: bearer …` header is as much a
  // credential as `Bearer …`, and tools echo headers in whatever case they got.
  [/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[REDACTED]"],
  // Assignment form: `API_KEY=…`, `token=…`, `export DB_PASSWORD='…'`.
  [
    new RegExp(`\\b${SECRET_NAME}\\s*=\\s*${SECRET_VALUE}`, "gi"),
    (_m: string, prefix: string | undefined, word: string) => `${prefix ?? ""}${word}=[REDACTED]`,
  ],
  // Colon form: JSON `"password":"…"`, YAML `api_key: …`, a header `x-api-key: …`.
  // Results are JSON-stringified before redaction, so this is the shape most
  // allowlisted output (span attributes) arrives in.
  [
    new RegExp(`\\b${SECRET_NAME}("?)(\\s*:\\s*)${SECRET_VALUE}`, "gi"),
    (_m: string, prefix: string | undefined, word: string, quote: string, sep: string) =>
      `${prefix ?? ""}${word}${quote}${sep}[REDACTED]`,
  ],
  // `scheme://user:pass@host` — the password segment of a connection URL.
  [/(:\/\/[^\s/:@]+:)[^@\s/]+@/g, "$1[REDACTED]@"],
  // A PEM private key, header to footer (or to the end of the text if the
  // footer is missing — the block is never worth keeping partially).
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    "-----BEGIN PRIVATE KEY-----[REDACTED]-----END PRIVATE KEY-----",
  ],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, rep] of PATTERNS)
    out = out.replace(re, rep as string & ((...a: never[]) => string));
  return out;
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
  let room = bytes - TRUNCATION_MARKER_BYTES;
  // Back off to a codepoint boundary. Cutting inside a multibyte sequence makes
  // the decoder emit a 3-byte U+FFFD for the fragment, which put the result —
  // and what was charged to the budget — over `bytes`.
  while (room > 0 && (buf[room] & 0xc0) === 0x80) room -= 1;
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
  /** Whether anything kept — an args leaf or the result — was cut. */
  truncated: boolean;
  withheld: "not-allowlisted" | "budget" | null;
} {
  // Args are captured for every tool, so they are the one thing every step
  // writes — and a `write` call carries its whole file body in them. Bound and
  // charge them like output, or the budgets only govern the smaller half.
  // One step allowance, shared by the args and the result below.
  const step = { remaining: budget.perStepBytes };
  const { args, truncated: argsTruncated } = capArgs(input.args, state, budget, step);
  const raw = toText(input.result);
  const outputBytes = Buffer.byteLength(raw, "utf8");
  if (!OUTPUT_ALLOWLIST.has(input.toolName)) {
    return { args, outputBytes, truncated: argsTruncated, withheld: "not-allowlisted" };
  }
  // Never spend past the run budget: the last step gets what is left, not a
  // full step on top of an almost-exhausted budget. Either allowance being
  // used up (by earlier steps, or by this step's own args) withholds the result
  // outright rather than keeping an empty string that reads as real output.
  const remaining = Math.min(step.remaining, budget.perRunBytes - state.spentBytes);
  if (remaining <= 0) {
    return { args, outputBytes, truncated: argsTruncated, withheld: "budget" };
  }
  const { text, truncated } = truncateTo(redactSecrets(raw), remaining);
  state.spentBytes += Buffer.byteLength(text, "utf8");
  return { args, result: text, outputBytes, truncated: argsTruncated || truncated, withheld: null };
}

/**
 * Redact and bound captured args against the same budgets as output, charging
 * what is kept. Serialising once and truncating the JSON would produce
 * unparseable metadata, so each string leaf is handled instead and the
 * structure survives.
 */
function capArgs(
  args: unknown,
  state: { spentBytes: number },
  budget: CaptureBudget,
  step: { remaining: number },
): { args: unknown; truncated: boolean } {
  let truncated = false;
  const cap = (value: unknown): unknown => {
    if (typeof value === "string") {
      // Both budgets bind: the step's remaining allowance is shared across every
      // leaf (a per-leaf cap would let an args object with many strings exceed
      // perStepBytes by a multiple of its leaf count), and the run's total is
      // the hard ceiling.
      const remaining = Math.min(step.remaining, budget.perRunBytes - state.spentBytes);
      if (remaining <= 0) {
        truncated = true;
        return "[withheld: budget]";
      }
      // Redact before cutting: a cut could otherwise split a token and defeat a
      // pattern.
      const cut = truncateTo(redactSecrets(value), remaining);
      truncated ||= cut.truncated;
      const spent = Buffer.byteLength(cut.text, "utf8");
      state.spentBytes += spent;
      step.remaining -= spent;
      return cut.text;
    }
    if (Array.isArray(value)) return value.map(cap);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, cap(v)]),
      );
    }
    return value;
  };
  return { args: cap(args), truncated };
}

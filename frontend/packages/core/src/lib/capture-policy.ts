/**
 * One policy for what tool I/O may be persisted — used by the agent's StreamPersister
 * (ai_messages.tool_step rows) and by the SDK's captureToolIo hook (spans). Both apply
 * the same redact/allowlist/truncate rules; whether they also stop capturing together
 * depends on their being handed the same `state` — each caller passing its own gives
 * each a full run budget. Order matters: redact, then allowlist, then truncate, then
 * budget — truncating first could split a token and defeat a pattern.
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

/** The marker every redaction — text-pattern or key-aware — replaces a secret with. */
export const REDACTED = "[REDACTED]";

const PATTERNS: Array<[RegExp, string | ((...args: never[]) => string)]> = [
  [/\b(gh[pousr]_)[A-Za-z0-9]{20,}/g, `$1${REDACTED}`],
  // OpenAI-style `sk-…` and Stripe `sk_live_…` / `sk_test_…`.
  [/\b(sk[-_](?:live_|test_)?)[A-Za-z0-9_-]{16,}/g, `$1${REDACTED}`],
  [/\bAKIA[0-9A-Z]{12,}/g, `AKIA${REDACTED}`],
  // Case-insensitive: an `authorization: bearer …` header is as much a
  // credential as `Bearer …`, and tools echo headers in whatever case they got.
  [/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`],
  // Assignment form: `API_KEY=…`, `token=…`, `export DB_PASSWORD='…'`.
  [
    new RegExp(`\\b${SECRET_NAME}\\s*=\\s*${SECRET_VALUE}`, "gi"),
    (_m: string, prefix: string | undefined, word: string) => `${prefix ?? ""}${word}=${REDACTED}`,
  ],
  // Colon form: JSON `"password":"…"`, YAML `api_key: …`, a header `x-api-key: …`.
  // Results are JSON-stringified before redaction, so this is the shape most
  // allowlisted output (span attributes) arrives in.
  [
    new RegExp(`\\b${SECRET_NAME}("?)(\\s*:\\s*)${SECRET_VALUE}`, "gi"),
    (_m: string, prefix: string | undefined, word: string, quote: string, sep: string) =>
      `${prefix ?? ""}${word}${quote}${sep}${REDACTED}`,
  ],
  // `scheme://user:pass@host` — the password segment of a connection URL.
  [/(:\/\/[^\s/:@]+:)[^@\s/]+@/g, `$1${REDACTED}@`],
  // A PEM private key, header to footer (or to the end of the text if the
  // footer is missing — the block is never worth keeping partially).
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    `-----BEGIN PRIVATE KEY-----${REDACTED}-----END PRIVATE KEY-----`,
  ],
];

// Credential-shaped object KEYS, checked independently of the text patterns
// above: `capArgs` walks object entries and, when a key matches, redacts the
// WHOLE value regardless of type — a key like `password` is damning on its
// own, unlike free text where a value shape is needed too. Matches only at
// the end of the key, case-insensitively: folding case is what makes
// `dbPassword`, `DB_PASSWORD` and `db-password` all match without a separate
// branch per separator style. Deliberately narrower than SECRET_NAME above —
// no bare `key`/`secret(s)` alternation beyond what's listed — because a
// false positive here silently blanks an entire args field (e.g. a tool's
// ordinary `sort_key` or `session_id` argument), not just a substring of
// logged text.
export const CREDENTIAL_KEY =
  /(?:password|passwd|pwd|secret|token|api[_-]?key|authorization|auth|cookie|session|private[_-]?key|access[_-]?key|credentials?|bearer|signature)$/i;

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

/**
 * Key-aware redaction for a structured value (a tool result that is an object
 * or array): a credential-shaped KEY blanks its whole value whatever the type,
 * and every string leaf goes through the text patterns. The text patterns alone
 * cannot see a `dbPassword` field once its value is serialised away from its
 * key, and their assignment/colon forms deliberately require an `_`-separated
 * name, so camelCase keys need this walk. Same rule `capArgs` applies to args.
 */
export function redactStructured(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactStructured);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        CREDENTIAL_KEY.test(k) ? REDACTED : redactStructured(v),
      ]),
    );
  }
  return value;
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
  // A structured result is redacted by key before it is serialised (the text
  // patterns below cannot see a credential-shaped key once it is just text);
  // a string result only has the text patterns.
  const raw = toText(
    input.result !== null && typeof input.result === "object"
      ? redactStructured(input.result)
      : input.result,
  );
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

/** What `capArgs` substitutes for a value it can't fit any more of the budget into. */
const WITHHELD_BUDGET = "[withheld: budget]";

/**
 * Redact and bound captured args against the same budgets as output, charging
 * what is kept — not just string leaves, but every byte the eventual
 * `JSON.stringify(args)` will actually contain: keys, punctuation, and
 * numbers/booleans/nulls too. A number-only or boolean-only payload (a
 * 100,000-element array, say) has no string leaves to charge against a
 * leaf-only budget and would otherwise be captured for free.
 *
 * Byte accounting here is close but not exact:
 *  - a key costs `JSON.stringify(key)` bytes plus 1 for its colon;
 *  - a scalar (number/boolean/null) costs `JSON.stringify(value)` bytes;
 *  - a string costs `redactSecrets`+`truncateTo`'s cut, plus 2 for the
 *    quotes `JSON.stringify` will wrap it in — the cut itself reserves those
 *    2 bytes first, so a string that gets cut lands on the budget exactly;
 *  - `{`/`}`/`[`/`]` cost 2 bytes per container, and each element after the
 *    first costs 1 for its separating comma.
 * A string's charge is its JSON-escaped size (quotes, `\"`, `\\`, control
 * characters included), and the cut is shrunk until that escaped size fits,
 * so a quote-heavy string cannot slip past either cap. Serialising once and
 * truncating the JSON would make this exact for punctuation too, but would
 * produce unparseable metadata on a mid-string cut.
 *
 * When the budget runs out partway through a container, the walk stops and
 * leaves ONE placeholder at the deepest node reached — `"[withheld: budget]"`
 * as a final array element, or a `"…"` key holding it in an object — and
 * every ancestor stops there too, so however deep the nesting, the result
 * carries a single (uncharged) sentinel rather than one per level.
 */
function capArgs(
  args: unknown,
  state: { spentBytes: number },
  budget: CaptureBudget,
  step: { remaining: number },
): { args: unknown; truncated: boolean } {
  let truncated = false;
  // Both budgets bind everywhere below: the step's remaining allowance is
  // shared across every leaf (a per-leaf cap would let an args object with
  // many leaves exceed perStepBytes by a multiple of its leaf count), and the
  // run's total is the hard ceiling.
  const remaining = () => Math.min(step.remaining, budget.perRunBytes - state.spentBytes);
  const spend = (bytes: number) => {
    state.spentBytes += bytes;
    step.remaining -= bytes;
  };

  // `exhausted` means the budget ran out ON this node, not merely inside a
  // descendant of it — it tells the caller (a container) to stop adding
  // siblings after this one rather than recurse into more nodes that would
  // each need their own placeholder.
  const cap = (value: unknown): { value: unknown; exhausted: boolean } => {
    if (typeof value === "string") {
      const room = remaining();
      // Less than the 2 quote bytes an empty string costs: nothing fits.
      if (room < 2) {
        truncated = true;
        return { value: WITHHELD_BUDGET, exhausted: true };
      }
      // Redact before cutting: a cut could otherwise split a token and defeat
      // a pattern. What is charged is the JSON-escaped size (quotes, `\"`,
      // `\\`, control characters), so the cut is bounded by that size too:
      // start from the raw allowance and shrink by the overshoot until the
      // escaped form fits — a string with no escapes converges in one pass.
      const redacted = redactSecrets(value);
      let target = room - 2;
      let cut = truncateTo(redacted, target);
      let escapedBytes = Buffer.byteLength(JSON.stringify(cut.text), "utf8");
      while (escapedBytes > room && target > 0) {
        target = Math.max(0, target - (escapedBytes - room));
        cut = truncateTo(redacted, target);
        escapedBytes = Buffer.byteLength(JSON.stringify(cut.text), "utf8");
      }
      truncated ||= cut.truncated;
      spend(escapedBytes);
      return { value: cut.text, exhausted: false };
    }
    if (value === null || typeof value === "number" || typeof value === "boolean") {
      const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
      if (bytes > remaining()) {
        truncated = true;
        return { value: WITHHELD_BUDGET, exhausted: true };
      }
      spend(bytes);
      return { value, exhausted: false };
    }
    // `undefined` (and functions/symbols, which tool args never carry) are
    // dropped by JSON.stringify itself and cost nothing.
    if (value === undefined) return { value: undefined, exhausted: false };
    if (Array.isArray(value)) {
      if (remaining() < 2) {
        truncated = true;
        return { value: WITHHELD_BUDGET, exhausted: true };
      }
      spend(2); // '[' + ']'
      const out: unknown[] = [];
      let exhausted = false;
      for (const el of value) {
        const sep = out.length > 0 ? 1 : 0;
        if (remaining() < sep) {
          truncated = true;
          out.push(WITHHELD_BUDGET);
          exhausted = true;
          break;
        }
        spend(sep);
        const capped = cap(el);
        out.push(capped.value);
        if (capped.exhausted) {
          // The sentinel already sits at the deepest node; report exhaustion
          // upward so no ancestor appends an (uncharged) sentinel of its own.
          truncated = true;
          exhausted = true;
          break;
        }
      }
      return { value: out, exhausted };
    }
    if (typeof value === "object") {
      if (remaining() < 2) {
        truncated = true;
        return { value: WITHHELD_BUDGET, exhausted: true };
      }
      spend(2); // '{' + '}'
      const out: Record<string, unknown> = {};
      let first = true;
      let exhausted = false;
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const sep = first ? 0 : 1;
        const keyBytes = Buffer.byteLength(JSON.stringify(k), "utf8") + 1; // + ':'
        if (remaining() < sep + keyBytes) {
          truncated = true;
          out["…"] = WITHHELD_BUDGET;
          exhausted = true;
          break;
        }
        spend(sep + keyBytes);
        first = false;
        // A credential-shaped key is damning on its own: replace the whole
        // value — whatever its type — rather than recursing into it. Charged
        // like any other string leaf, via the same `cap`.
        const capped = CREDENTIAL_KEY.test(k) ? cap(REDACTED) : cap(v);
        out[k] = capped.value;
        if (capped.exhausted) {
          truncated = true;
          exhausted = true;
          break;
        }
      }
      return { value: out, exhausted };
    }
    return { value, exhausted: false };
  };
  return { args: cap(args).value, truncated };
}

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
export const DEFAULT_CAPTURE_BUDGET: CaptureBudget = { perStepBytes: 8_192, perRunBytes: 262_144 };

/** Tools whose output is data the customer already owns inside TraceRoot. */
const OUTPUT_ALLOWLIST: ReadonlySet<string> = new Set([
  "download_traces",
  "download_session",
  "submit_result",
]);

// A credential name is the bare word or ends with `_word`, so `monkey=` and
// `token_count=` stay readable while `api_key=` and `DB_PASSWORD=` do not.
// Known false positives, accepted for the sake of a short pattern: `sort_key=`,
// `primary_key=` and a URL's `?key=` are redacted too (the row is shown to the
// user and, since the session rebuild restores tool steps, read back by the
// model as a bounded summary — a redacted key in either place is the safe
// side).
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
 * Text redaction that also sees through JSON. A string leaf (or a string tool
 * result) is often a JSON document in disguise: a tool that returns
 * `JSON.stringify({ apiToken })` hands over a credential under a camelCase key
 * the text patterns never match, since their assignment and colon forms need
 * an `_`-separated name. Parse it, redact it by key like any structured value,
 * and re-serialise only when that changed something, so a document with
 * nothing to hide keeps its original whitespace. Anything that is not a JSON
 * object or array goes through the text patterns as before.
 */
function redactText(text: string): string {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return redactSecrets(text);
    }
    if (parsed !== null && typeof parsed === "object") {
      const redacted = safeRedactStructured(parsed);
      if (redacted === REDACTED) return REDACTED;
      const before = JSON.stringify(parsed);
      const after = JSON.stringify(redacted);
      return after === before ? redactSecrets(text) : redactSecrets(after);
    }
  }
  return redactSecrets(text);
}

/** Deeper than any tool result worth keeping; far shallower than any runtime's stack. */
const MAX_REDACT_DEPTH = 256;

/**
 * `redactStructured` for a value of unknown depth. The walk is recursive and
 * `JSON.parse` accepts nesting far deeper than the call stack allows, so a
 * pathological result would fail here before the byte budget ever cut it,
 * and the whole tool step would fail to persist. Withholding the value is
 * the safe failure: a document too deep to inspect for credentials is not
 * one to keep.
 */
function safeRedactStructured(value: unknown): unknown {
  try {
    return redactStructured(value);
  } catch {
    return REDACTED;
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
export function redactStructured(value: unknown, depth = 0): unknown {
  // Bounded, not just guarded: the stack size that turns a deep document into
  // a RangeError differs between runtimes, so the cut-off is a fixed depth
  // and the failure is the same everywhere. `safeRedactStructured` turns it
  // into a withheld value.
  if (depth > MAX_REDACT_DEPTH) {
    throw new RangeError(`structured value nested deeper than ${MAX_REDACT_DEPTH}`);
  }
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((v) => redactStructured(v, depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        CREDENTIAL_KEY.test(k) ? REDACTED : redactStructured(v, depth + 1),
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

/**
 * Redact, then bound to `bytes` of UTF-8, marker included: the one helper
 * for a text a span stores whole rather than through the step budget — the
 * self-trace root's prompt and answer, an LLM span's rendered input and
 * output. Redaction runs first (a cut could split a token and defeat a
 * pattern); the cut is byte-safe, so a CJK or emoji text lands under the
 * same ceiling as ASCII instead of three times over it.
 */
export function boundedText(text: string, bytes: number): string {
  // The JSON-aware form: a text that is itself a JSON document (a prompt
  // that pastes a config, an answer that quotes one) takes the key walk,
  // so `{"apiToken": …}` is blanked by its key, not left to the patterns.
  return truncateTo(redactText(text), bytes).text;
}

/**
 * Key-aware redaction for a value about to be serialised into a span — a
 * tool call's arguments inside a model message, a rendered message list. A
 * credential-shaped key blanks its whole value; every string leaf takes the
 * JSON-aware text redaction (so a leaf that is itself a JSON document gets
 * the key walk too). A value too deep to walk degrades whole to the marker.
 * A bare string is redacted like a leaf.
 */
export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactText(value);
  return value !== null && typeof value === "object" ? safeRedactStructured(value) : value;
}

/** What a kept result is stored as: text stays text, a structured value stays structured. */
export type CapturedResult = string | Record<string, unknown> | unknown[] | number | boolean | null;

export function applyCapturePolicy(
  input: {
    toolName: string;
    args: unknown;
    result: unknown;
    /**
     * The caller vouches that this tool's output is the customer's own
     * TraceRoot data, so it is kept like an allow-listed tool's. The agent
     * sets it for the registry-bound API tools (`create_alert`, `get_alert`,
     * …): their results are the resources the API returned, and the session
     * rebuild and the chat cards read the outcome back from the stored row.
     */
    keepOutput?: boolean;
  },
  state: { spentBytes: number },
  budget: CaptureBudget = DEFAULT_CAPTURE_BUDGET,
): {
  args: unknown;
  /**
   * A string result is kept as redacted, truncated text. A structured result
   * is kept structured, bounded leaf by leaf the way args are, so a small
   * field beside a large one (a created resource's `details` next to its
   * `content`) survives instead of being cut off with the tail of one big
   * string; oversized leaves become the `"[withheld: budget]"` sentinel.
   */
  result?: CapturedResult;
  outputBytes: number;
  /** Whether anything kept — an args leaf, the result or one of its leaves — was cut. */
  truncated: boolean;
  withheld: "not-allowlisted" | "budget" | null;
} {
  // Args are captured for every tool, so they are the one thing every step
  // writes — and a `write` call carries its whole file body in them. Bound and
  // charge them like output, or the budgets only govern the smaller half.
  // One step allowance is shared by the args and the result, but when both
  // want more than fits, the args may take at most half of it: a large args
  // payload (a dashboard spec, a file body) must not starve the result — the
  // created resource's id — that the session rebuild reads back later.
  const keep = input.keepOutput === true || OUTPUT_ALLOWLIST.has(input.toolName);
  const wantArgs = serializedBytes(input.args);
  const wantResult = keep ? serializedBytes(input.result) : 0;
  const argsAllowance =
    wantArgs + wantResult <= budget.perStepBytes
      ? budget.perStepBytes
      : Math.max(Math.floor(budget.perStepBytes / 2), budget.perStepBytes - wantResult);
  const step = { remaining: Math.min(budget.perStepBytes, argsAllowance) };
  const { args, truncated: argsTruncated } = capArgs(input.args, state, budget, step);
  // Whatever the args left of the step goes to the result.
  step.remaining += budget.perStepBytes - Math.min(budget.perStepBytes, argsAllowance);
  // `outputBytes` is what the tool actually returned — the size a withheld
  // step reports — so it is measured before any redaction changes the text.
  const outputBytes = Buffer.byteLength(toText(input.result), "utf8");
  if (!keep) {
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
  if (typeof input.result === "string") {
    // A string result gets the key walk if it parses as JSON (the text
    // patterns cannot see a credential-shaped key once it is just text), and
    // the text patterns otherwise; then the cut.
    const { text, truncated } = truncateTo(redactSecrets(redactText(input.result)), remaining);
    state.spentBytes += Buffer.byteLength(text, "utf8");
    return {
      args,
      result: text,
      outputBytes,
      truncated: argsTruncated || truncated,
      withheld: null,
    };
  }
  if (input.result === undefined) {
    return { args, outputBytes, truncated: argsTruncated, withheld: null };
  }
  // A structured result takes the same walk as the args: redacted by key and
  // by text pattern at every leaf, charged leaf by leaf against what is left
  // of the step, so a small field survives beside a large one. A value nested
  // too deeply to walk degrades whole to the marker, as a string would.
  const probe =
    typeof input.result === "object" ? safeRedactStructured(input.result) : input.result;
  if (probe === REDACTED) {
    state.spentBytes += Buffer.byteLength(JSON.stringify(REDACTED), "utf8");
    return { args, result: REDACTED, outputBytes, truncated: argsTruncated, withheld: null };
  }
  const { args: result, truncated } = capArgs(input.result, state, budget, step);
  return {
    args,
    result: result as CapturedResult,
    outputBytes,
    truncated: argsTruncated || truncated,
    withheld: null,
  };
}

/** JSON-serialised size of a value, for ordering; unserialisable sorts last. */
function serializedBytes(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
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
 *  - a string costs `redactText`+`truncateTo`'s cut, plus 2 for the
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
      const redacted = redactText(value);
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
      // Entries are charged smallest first, so a large field takes the cut
      // and its small siblings survive (a created resource's `details` beside
      // a long `content`); the output keeps the original key order.
      const entries = Object.entries(value as Record<string, unknown>);
      const bySize = entries
        .map(([k, v], i) => ({ k, v, i, bytes: serializedBytes(v) }))
        .sort((a, b) => a.bytes - b.bytes || a.i - b.i);
      const kept = new Map<string, unknown>();
      let first = true;
      let exhausted = false;
      for (const { k, v } of bySize) {
        const sep = first ? 0 : 1;
        const keyBytes = Buffer.byteLength(JSON.stringify(k), "utf8") + 1; // + ':'
        if (remaining() < sep + keyBytes) {
          truncated = true;
          exhausted = true;
          break;
        }
        spend(sep + keyBytes);
        first = false;
        // A credential-shaped key is damning on its own: replace the whole
        // value — whatever its type — rather than recursing into it. Charged
        // like any other string leaf, via the same `cap`.
        const capped = CREDENTIAL_KEY.test(k) ? cap(REDACTED) : cap(v);
        kept.set(k, capped.value);
        if (capped.exhausted) {
          truncated = true;
          exhausted = true;
          break;
        }
      }
      const out: Record<string, unknown> = {};
      for (const [k] of entries) if (kept.has(k)) out[k] = kept.get(k);
      // One sentinel stands for every entry that did not fit, at the end.
      if (exhausted && kept.size < entries.length) out["…"] = WITHHELD_BUDGET;
      return { value: out, exhausted };
    }
    return { value, exhausted: false };
  };
  return { args: cap(args).value, truncated };
}

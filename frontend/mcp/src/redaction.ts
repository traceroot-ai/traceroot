/**
 * Credential redaction for tool results.
 *
 * Trace content is whatever an application recorded: span attributes and
 * metadata routinely carry request headers, client configuration and provider
 * URLs, and with them API keys. A model reading a trace has no use for a
 * credential, and once a key is in its context it can end up anywhere, so every
 * result is passed through this rule before it is returned, whatever `fields`
 * asked for.
 *
 * The rule:
 *
 * - A value under a credential-like KEY is replaced with "[REDACTED]", at any
 *   depth. The key is split into words (snake, kebab, dotted and camel case) and
 *   is a credential when its last word is one of CREDENTIAL_WORDS (password,
 *   secret, authorization, cookie, apikey, …), its last two words are one of
 *   CREDENTIAL_PAIRS (api key, private key, access token, set cookie, …), or it
 *   is a bare or prefixed `token` (auth_token, x-token) that is not a paging
 *   token (next/page/continuation/cursor). Token COUNTS never match: their last
 *   word is `tokens`, `count` or similar (prompt_tokens, llm.usage.total_tokens,
 *   llm.token_count.prompt). Numbers and booleans are never redacted, so a count
 *   or flag under any key survives.
 * - `{key, value}` pairs (an attribute list) are judged by their `key`.
 * - In every string, wherever it sits: a URL's secret query parameters
 *   (SECRET_QUERY_PARAMS) and user:password are redacted, and values that look
 *   like credentials on their own (a `Bearer …` token, `sk-…` provider keys,
 *   PEM private keys, AWS access key ids, GitHub and Slack tokens, JWTs) are
 *   replaced.
 * - A string holding a JSON object or array (how OpenTelemetry attributes carry
 *   structured values) is parsed, redacted by the same rule and re-encoded.
 *
 * Each object that lost a value gets `_redactedKeys` listing the keys, so the
 * model knows something was there and why it cannot see it.
 */

export const REDACTED = "[REDACTED]";

/** Where an object lists the keys whose values were redacted. */
export const REDACTED_KEYS_FIELD = "_redactedKeys";

const CREDENTIAL_WORDS = new Set([
  "password",
  "passwd",
  "passphrase",
  "secret",
  "authorization",
  "cookie",
  "cookies",
  "apikey",
  "credential",
  "credentials",
  "privatekey",
]);

const CREDENTIAL_PAIRS = new Set([
  "api key",
  "private key",
  "secret key",
  "signing key",
  "encryption key",
  "access key",
  "client secret",
  "access token",
  "refresh token",
  "id token",
  "session token",
  "auth token",
  "bearer token",
  "security token",
  "set cookie",
  "api token",
]);

/** Words before `token` that make it a paging cursor, not a credential. */
const PAGING_WORDS = new Set(["next", "page", "continuation", "cursor", "pagination", "prev"]);

/** Query parameters that carry a credential in a URL. */
const SECRET_QUERY_PARAMS = new Set([
  "api_key",
  "apikey",
  "api-key",
  "key",
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "auth",
  "auth_token",
  "password",
  "secret",
  "client_secret",
  "sig",
  "signature",
  "x-amz-signature",
  "x-amz-credential",
  "x-amz-security-token",
  "code",
]);

/** Values that are credentials whatever key they sit under. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  // A bearer token: long, or with a digit, so "Bearer instruments" in prose survives.
  /\bBearer\s+(?:[A-Za-z0-9\-._~+/]{16,}|(?=[A-Za-z\-._~+/]*\d)[A-Za-z0-9\-._~+/]{8,})=*/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;

/** Longest string parsed as embedded JSON; longer ones only get the pattern pass. */
const MAX_EMBEDDED_JSON_CHARS = 200_000;

/** The words of a key: `llm.usage.prompt_tokens` → [llm, usage, prompt, tokens]. */
function words(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "");
}

/** Whether a key names a credential, per the rule above. */
export function isCredentialKey(key: string): boolean {
  const parts = words(key);
  const last = parts.at(-1);
  if (last === undefined) return false;
  if (CREDENTIAL_WORDS.has(last)) return true;
  if (parts.length >= 2 && CREDENTIAL_PAIRS.has(`${parts.at(-2)} ${last}`)) return true;
  if (last === "token") {
    const before = parts.at(-2);
    return before === undefined || !PAGING_WORDS.has(before);
  }
  return false;
}

/** Counts what a redaction pass removed. */
export interface RedactionTally {
  redactions: number;
}

/** Redact `value` by the rule above, counting into `tally`. Returns a new value. */
export function redactCredentials(
  value: unknown,
  tally: RedactionTally = { redactions: 0 },
): unknown {
  return redactValue(value, tally).value;
}

interface Redacted {
  value: unknown;
  changed: boolean;
}

function redactValue(value: unknown, tally: RedactionTally): Redacted {
  if (typeof value === "string") {
    return redactString(value, tally);
  }
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const result = redactValue(item, tally);
      changed ||= result.changed;
      return result.value;
    });
    return { value: changed ? items : value, changed };
  }
  if (typeof value === "object" && value !== null) {
    return redactObject(value as Record<string, unknown>, tally);
  }
  return { value, changed: false };
}

function redactObject(object: Record<string, unknown>, tally: RedactionTally): Redacted {
  const out: Record<string, unknown> = {};
  const redactedKeys: string[] = [];
  let changed = false;
  // An attribute-list entry: the credential is named by `key`, held in `value`.
  const pairKey =
    typeof object.key === "string" && "value" in object && isCredentialKey(object.key)
      ? object.key
      : undefined;
  for (const [key, item] of Object.entries(object)) {
    if (
      (isCredentialKey(key) || (pairKey !== undefined && key === "value")) &&
      isSecretCarrier(item)
    ) {
      out[key] = REDACTED;
      redactedKeys.push(pairKey !== undefined && key === "value" ? pairKey : key);
      tally.redactions++;
      changed = true;
      continue;
    }
    const result = redactValue(item, tally);
    if (result.changed) {
      changed = true;
      if (typeof item === "string") redactedKeys.push(key);
    }
    out[key] = result.value;
  }
  if (!changed) return { value: object, changed: false };
  if (redactedKeys.length > 0 && !(REDACTED_KEYS_FIELD in object)) {
    out[REDACTED_KEYS_FIELD] = redactedKeys;
  }
  return { value: out, changed: true };
}

/** A count, flag or empty value carries no secret; anything else under a credential key does. */
function isSecretCarrier(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "number" || typeof value === "boolean") return false;
  if (typeof value === "string") return value !== "" && value !== REDACTED;
  return true;
}

function redactString(text: string, tally: RedactionTally): Redacted {
  const embedded = redactEmbeddedJson(text, tally);
  if (embedded) return embedded;
  let out = text.replace(URL_PATTERN, (url) => redactUrl(url, tally));
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match) => {
      tally.redactions++;
      return match.startsWith("Bearer") ? `Bearer ${REDACTED}` : REDACTED;
    });
  }
  return out === text ? { value: text, changed: false } : { value: out, changed: true };
}

/** A string that is a JSON object or array, redacted inside and re-encoded. */
function redactEmbeddedJson(text: string, tally: RedactionTally): Redacted | undefined {
  const trimmed = text.trimStart();
  if (
    !(trimmed.startsWith("{") || trimmed.startsWith("[")) ||
    text.length > MAX_EMBEDDED_JSON_CHARS
  ) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const result = redactValue(parsed, tally);
  return result.changed
    ? { value: JSON.stringify(result.value), changed: true }
    : { value: text, changed: false };
}

/**
 * A URL with its secret query parameters and any user:password redacted. Done
 * on the text, not through URL parsing, so the rest of the URL reads exactly as
 * it was recorded.
 */
function redactUrl(url: string, tally: RedactionTally): string {
  let out = url.replace(
    /^([a-z][a-z0-9+.-]*:\/\/[^/?#@:]*):([^/?#@]+)@/i,
    (match, head: string, password: string) => {
      if (password === REDACTED) return match;
      tally.redactions++;
      return `${head}:${REDACTED}@`;
    },
  );
  out = out.replace(
    /([?&])([^=&#]+)=([^&#]*)/g,
    (match, separator: string, name: string, value: string) => {
      if (
        value === "" ||
        value === REDACTED ||
        !SECRET_QUERY_PARAMS.has(safeDecode(name).toLowerCase())
      ) {
        return match;
      }
      tally.redactions++;
      return `${separator}${name}=${REDACTED}`;
    },
  );
  return out;
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

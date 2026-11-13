/**
 * Minimal fetch client for the OpenAI Decisions API (`POST {baseUrl}/decisions`).
 *
 * Same contract as typesafe-client.ts: a response missing an answer, option or
 * in-range probability is an error, and so is a refusal, so a bad answer fails
 * the run instead of producing a finding. Those errors carry the usage OpenAI
 * billed for the response. 429 and 5xx are retried, honouring retry-after,
 * with the TOTAL time (attempts plus waits) capped by `deadlineMs`. Error
 * messages carry the provider's error text with the configured key and
 * anything credential-shaped redacted, since a provider (or a proxy at the
 * BYOK base URL) can echo the request's Authorization header. A response body
 * is read up to MAX_RESPONSE_BYTES: the base URL is the provider's, so the
 * deadline bounds how long a response takes but not how much it sends.
 */

import { REDACTED, redactValue } from "@traceroot/core/capture-policy";
import { abortableSleep, retryDelayMs, MAX_RETRIES, type JsonValue } from "./typesafe-client.js";

/** Far above any real response (two answers and the usage are a few KB). */
export const MAX_RESPONSE_BYTES = 1024 * 1024;

class ResponseTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`response body is over the ${maxBytes}-byte limit`);
    this.name = "ResponseTooLargeError";
  }
}

/**
 * The body as text, read a chunk at a time and cancelled as soon as it passes
 * `maxBytes`, so an oversized response is never buffered whole. A declared
 * Content-Length over the limit fails before anything is read.
 */
async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new ResponseTooLargeError(maxBytes);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ResponseTooLargeError(maxBytes);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** Yes/no question; the answer is P(yes). */
export interface PredicateQuestion {
  type: "predicate";
  instructions: string;
}

/** Pick-one question over `choices[].value`. */
export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  choices: { value: string; description: string }[];
}

export type DecisionsQuestion = PredicateQuestion | ChoiceQuestion;

/** Questions keyed by the `name` each is sent and answered under. */
export type DecisionsQuestions = Record<string, DecisionsQuestion>;

/** A user message of JSON data; the questions refer to its keys by name. */
export type DecisionsInput = {
  role: "user";
  content: { type: "input_json"; data: JsonValue }[];
}[];

export interface PredicateAnswer {
  type: "predicate";
  probability: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  /** Every asked value; one the response omits is 0. */
  probabilities: Record<string, number>;
}

type AnswerFor<Q> = Q extends PredicateQuestion ? PredicateAnswer : ChoiceAnswer;

/**
 * `inputTokens` is OpenAI's `input_tokens`, which already includes the cache
 * read and write tokens; they are not added to it.
 */
export interface DecisionsUsage {
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export interface DecisionsResult<Q extends DecisionsQuestions = DecisionsQuestions> {
  answers: { [K in keyof Q]: AnswerFor<Q[K]> };
  usage: DecisionsUsage;
  model: string | null;
}

export interface CallDecisionsOptions<Q extends DecisionsQuestions> {
  apiKey: string;
  /** API base including the version segment, e.g. `https://api.openai.com/v1`. */
  baseUrl: string;
  model: string;
  input: DecisionsInput;
  questions: Q;
  /** Total time budget in ms for the whole call, retries and waits included. */
  deadlineMs: number;
}

export async function callDecisions<Q extends DecisionsQuestions>(
  opts: CallDecisionsOptions<Q>,
): Promise<DecisionsResult<Q>> {
  const { apiKey, baseUrl, model, input, questions, deadlineMs } = opts;
  const url = `${baseUrl.replace(/\/+$/, "")}/decisions`;
  const payload = JSON.stringify({
    model,
    input,
    questions: Object.entries(questions).map(([name, q]) => ({ name, ...q })),
  });
  const startedAt = Date.now();
  const timeoutMessage = `OpenAI decisions timed out after ${deadlineMs}ms (model=${model})`;

  // The deadline timer aborts an in-flight fetch or a backoff wait.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, deadlineMs));
  timer.unref?.();

  try {
    for (let attempt = 0; ; attempt++) {
      if (controller.signal.aborted) throw new Error(timeoutMessage);

      let response: Response;
      let text: string;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: payload,
          signal: controller.signal,
        });
        text = await readBoundedText(response, MAX_RESPONSE_BYTES).catch((err: unknown) => {
          // An oversized error body is dropped, not the error: its status
          // still names the failure and decides the retry below.
          if (!response.ok && err instanceof ResponseTooLargeError) return "";
          throw err;
        });
      } catch (err) {
        if (controller.signal.aborted) throw new Error(timeoutMessage);
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`OpenAI decisions request failed: ${scrubErrorText(reason, apiKey)}`);
      }

      if (response.ok) return parseResult(text, questions);

      const error = statusError(response.status, text, apiKey);
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= MAX_RETRIES) throw error;

      const waitMs = retryDelayMs(response.headers, attempt);
      const remainingMs = deadlineMs - (Date.now() - startedAt);
      // A wait that would outlive the deadline can't lead to a usable answer;
      // surface the error now rather than a later timeout.
      if (waitMs >= remainingMs) throw error;
      await abortableSleep(waitMs, controller.signal);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Usage OpenAI billed for a response we rejected, or null when the failure
 * happened before any usage could be read.
 */
export function decisionsUsageFromError(err: unknown): DecisionsUsage | null {
  const usage = err instanceof Error ? (err as { usage?: unknown }).usage : undefined;
  if (
    !isRecord(usage) ||
    !isTokenCount(usage.inputTokens) ||
    !isTokenCount(usage.cachedTokens) ||
    !isTokenCount(usage.cacheWriteTokens) ||
    !isTokenCount(usage.outputTokens)
  ) {
    return null;
  }
  return {
    inputTokens: usage.inputTokens,
    cachedTokens: usage.cachedTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    outputTokens: usage.outputTokens,
  };
}

function statusError(status: number, rawBody: string, apiKey: string): Error {
  const detail = describeDetail(scrubErrorText(rawBody, apiKey));
  return new Error(`OpenAI decisions returned ${status}${detail ? `: ${detail}` : ""}`);
}

/**
 * Provider error text with the configured key removed wherever it appears,
 * then through the shared capture redaction (`Bearer …`, `sk-…`,
 * credential-named keys, JSON inside a string). The exact-key pass catches a
 * key no pattern recognises. Both run on the whole text, before
 * `describeDetail` cuts it, so a cut can't leave part of a key behind for the
 * patterns to miss.
 */
function scrubErrorText(text: string, apiKey: string): string {
  const withoutKey = apiKey ? text.split(apiKey).join(REDACTED) : text;
  return String(redactValue(withoutKey));
}

/** OpenAI's error envelope is `{error: {message, type, code}}`. */
function describeDetail(rawBody: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return rawBody.trim() ? rawBody.trim().slice(0, 200) : null;
  }
  const error = isRecord(parsed) ? parsed.error : undefined;
  if (isRecord(error)) {
    const parts = [error.code ?? error.type, error.message].filter(
      (p): p is string => typeof p === "string" && p.length > 0,
    );
    return parts.length ? parts.join(" - ").slice(0, 500) : null;
  }
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isProbability(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}

/** The detector usage row stores token counts in an Int32 column. */
const MAX_TOKEN_COUNT = 2_147_483_647;

/** A whole, non-negative count that the usage row can store as-is. */
function isTokenCount(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= MAX_TOKEN_COUNT;
}

/** OpenAI answered, but the body is not a usable answer to the questions asked. */
export class MalformedDecisionsResponseError extends Error {}

/** OpenAI declined to answer a question; the run fails with the billed usage. */
export class DecisionRefusedError extends Error {}

function malformed(reason: string): Error {
  return new MalformedDecisionsResponseError(
    `OpenAI decisions returned a malformed response: ${reason}`,
  );
}

function parseUsage(raw: unknown): DecisionsUsage {
  if (!isRecord(raw) || !isTokenCount(raw.input_tokens)) {
    throw malformed("missing or invalid usage");
  }
  const details = raw.input_tokens_details;
  const detail = (key: string): number => {
    if (details === undefined || details === null) return 0;
    if (!isRecord(details)) throw malformed("invalid usage.input_tokens_details");
    const v = details[key];
    if (v === undefined || v === null) return 0;
    if (!isTokenCount(v)) throw malformed(`invalid usage.input_tokens_details.${key}`);
    return v;
  };
  const cachedTokens = detail("cached_tokens");
  const cacheWriteTokens = detail("cache_write_tokens");
  if (cachedTokens + cacheWriteTokens > raw.input_tokens) {
    throw malformed("cache tokens exceed input_tokens");
  }
  // Output is not billed and the docs name no output count; read one if sent.
  const output = raw.output_tokens;
  if (output !== undefined && output !== null && !isTokenCount(output)) {
    throw malformed("invalid usage.output_tokens");
  }
  return {
    inputTokens: raw.input_tokens,
    cachedTokens,
    cacheWriteTokens,
    outputTokens: typeof output === "number" ? output : 0,
  };
}

function parseResult<Q extends DecisionsQuestions>(text: string, questions: Q): DecisionsResult<Q> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw malformed("body is not JSON");
  }
  if (!isRecord(parsed)) throw malformed("body is not an object");

  // Usage is read before the answers are checked: OpenAI bills a 200 whose
  // answers we then reject, so the error has to carry the tokens to bill.
  const billed = parseUsage(parsed.usage);

  const answers: Record<string, PredicateAnswer | ChoiceAnswer> = {};
  try {
    if (!Array.isArray(parsed.answers)) throw malformed("missing answers");
    const byName = new Map<string, Record<string, unknown>>();
    for (const raw of parsed.answers) {
      if (isRecord(raw) && typeof raw.name === "string" && !byName.has(raw.name)) {
        byName.set(raw.name, raw);
      }
    }
    for (const [name, question] of Object.entries(questions)) {
      const raw = byName.get(name);
      if (!raw) throw malformed(`question "${name}" was not answered`);
      if (raw.type === "refusal") {
        throw new DecisionRefusedError(`OpenAI decisions refused to answer question "${name}"`);
      }
      if (raw.type !== question.type) {
        throw malformed(`answer "${name}" has type ${String(raw.type)}, expected ${question.type}`);
      }
      answers[name] =
        question.type === "predicate"
          ? parsePredicate(name, raw)
          : parseChoice(
              name,
              raw,
              question.choices.map((c) => c.value),
            );
    }
    if (parsed.model !== undefined && parsed.model !== null && typeof parsed.model !== "string") {
      throw malformed("model is not a string");
    }
  } catch (err) {
    throw err instanceof Error ? Object.assign(err, { usage: billed }) : err;
  }

  return {
    // Each answer was checked above against its question's type.
    answers: answers as DecisionsResult<Q>["answers"],
    usage: billed,
    model: typeof parsed.model === "string" ? parsed.model : null,
  };
}

function parsePredicate(name: string, raw: Record<string, unknown>): PredicateAnswer {
  if (!isProbability(raw.probability)) {
    throw malformed(`answer "${name}" probability is not in [0,1]`);
  }
  return { type: "predicate", probability: raw.probability };
}

function parseChoice(name: string, raw: Record<string, unknown>, options: string[]): ChoiceAnswer {
  if (typeof raw.choice !== "string" || !options.includes(raw.choice)) {
    throw malformed(`answer "${name}" choice ${JSON.stringify(raw.choice)} is not an option`);
  }
  if (!isProbability(raw.confidence)) {
    throw malformed(`answer "${name}" confidence is not in [0,1]`);
  }
  if (!Array.isArray(raw.probabilities)) throw malformed(`answer "${name}" has no probabilities`);

  // The docs don't promise every option is listed, so an omitted one is 0.
  const probabilities: Record<string, number> = Object.fromEntries(options.map((o) => [o, 0]));
  const seen = new Set<string>();
  for (const entry of raw.probabilities) {
    if (!isRecord(entry) || typeof entry.value !== "string" || !options.includes(entry.value)) {
      throw malformed(`answer "${name}" has a probability for an option that was not asked`);
    }
    if (seen.has(entry.value)) {
      throw malformed(`answer "${name}" lists "${entry.value}" twice`);
    }
    if (!isProbability(entry.probability)) {
      throw malformed(`answer "${name}" probability for "${entry.value}" is not in [0,1]`);
    }
    seen.add(entry.value);
    probabilities[entry.value] = entry.probability;
  }
  return { type: "choice", choice: raw.choice, confidence: raw.confidence, probabilities };
}

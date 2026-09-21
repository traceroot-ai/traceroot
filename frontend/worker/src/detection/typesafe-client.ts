/**
 * Minimal fetch client for TypeSafe's System One (`POST {baseUrl}/systemone`).
 *
 * A response missing an answer, option or in-range probability is an error,
 * so a bad answer fails the run instead of producing a finding. Only 429 and
 * 529 are retried, honouring retry-after, with the TOTAL time (attempts plus
 * waits) capped by `deadlineMs`. Error messages carry TypeSafe's error detail
 * but never the API key.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Yes/no question; the answer is P(yes). */
export interface NoulQuestion {
  type: "noul";
  instructions: JsonValue;
  criteria?: { true?: JsonValue; false?: JsonValue };
}

/** Pick-one question over the keys of `criteria`. */
export interface ChoiceQuestion {
  type: "choice";
  instructions: JsonValue;
  criteria: Record<string, JsonValue>;
}

export type SystemOneQuestion = NoulQuestion | ChoiceQuestion;

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export type SystemOneAnswer = NoulAnswer | ChoiceAnswer;

export type SystemOneQuestions = Record<string, SystemOneQuestion>;

type AnswerFor<Q> = Q extends NoulQuestion ? NoulAnswer : ChoiceAnswer;

export interface SystemOneResult<Q extends SystemOneQuestions = SystemOneQuestions> {
  answers: { [K in keyof Q]: AnswerFor<Q[K]> };
  usage: { inputTokens: number; outputTokens: number };
  model: string | null;
}

export interface CallSystemOneOptions<Q extends SystemOneQuestions> {
  apiKey: string;
  /** API base including the version segment, e.g. `https://api.typesafe.ai/v1`. */
  baseUrl: string;
  model: string;
  state: JsonValue;
  questions: Q;
  /** Total time budget in ms for the whole call, retries and waits included. */
  deadlineMs: number;
}

/** Retries after the first attempt, for 429/529 only. */
export const MAX_RETRIES = 2;
/** Backoff when the server sends no retry-after header: 500ms, then 1s. */
const BASE_BACKOFF_MS = 500;

export async function callSystemOne<Q extends SystemOneQuestions>(
  opts: CallSystemOneOptions<Q>,
): Promise<SystemOneResult<Q>> {
  const { apiKey, baseUrl, model, state, questions, deadlineMs } = opts;
  const url = `${baseUrl.replace(/\/+$/, "")}/systemone`;
  const payload = JSON.stringify({ model, state, questions });
  const startedAt = Date.now();
  const timeoutMessage = `TypeSafe systemone timed out after ${deadlineMs}ms (model=${model})`;

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
        text = await response.text();
      } catch (err) {
        if (controller.signal.aborted) throw new Error(timeoutMessage);
        throw new Error(
          `TypeSafe request failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (response.ok) return parseResult(text, questions);

      const error = statusError(response.status, text);
      const retryable = response.status === 429 || response.status === 529;
      if (!retryable || attempt >= MAX_RETRIES) throw error;

      const waitMs = retryDelayMs(response.headers, attempt);
      const remainingMs = deadlineMs - (Date.now() - startedAt);
      // A wait that would outlive the deadline can't lead to a usable answer;
      // surface the rate-limit error now rather than a later timeout.
      if (waitMs >= remainingMs) throw error;
      await abortableSleep(waitMs, controller.signal);
    }
  } finally {
    clearTimeout(timer);
  }
}

function statusError(status: number, rawBody: string): Error {
  const detail = describeDetail(rawBody);
  const message = `TypeSafe systemone returned ${status}${detail ? `: ${detail}` : ""}`;
  return new Error(message);
}

/**
 * Short description of TypeSafe's error envelope: `detail` is either
 * `{error_type, message?}` (400/401) or a pydantic error array (422).
 */
function describeDetail(rawBody: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return rawBody.trim() ? rawBody.trim().slice(0, 200) : null;
  }
  const detail = isRecord(parsed) ? parsed.detail : undefined;
  if (isRecord(detail)) {
    const parts = [detail.error_type, detail.message].filter(
      (p): p is string => typeof p === "string" && p.length > 0,
    );
    return parts.length ? parts.join(" - ") : null;
  }
  if (Array.isArray(detail)) {
    const msgs = detail
      .map((d) =>
        isRecord(d) && typeof d.msg === "string"
          ? `${Array.isArray(d.loc) ? d.loc.join(".") : "?"}: ${d.msg}`
          : null,
      )
      .filter((m): m is string => m !== null);
    return msgs.length ? msgs.join("; ").slice(0, 500) : null;
  }
  return null;
}

/** retry-after-ms, then retry-after (seconds or HTTP date), then exponential backoff. */
function retryDelayMs(headers: Headers, attempt: number): number {
  const ms = Number(headers.get("retry-after-ms"));
  if (headers.get("retry-after-ms") !== null && Number.isFinite(ms) && ms >= 0) return ms;
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (retryAfter.trim() !== "" && Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return BASE_BACKOFF_MS * 2 ** attempt;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isProbability(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}

function isTokenCount(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

function malformed(reason: string): Error {
  return new Error(`TypeSafe returned a malformed response: ${reason}`);
}

function parseResult<Q extends SystemOneQuestions>(text: string, questions: Q): SystemOneResult<Q> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw malformed("body is not JSON");
  }
  if (!isRecord(parsed)) throw malformed("body is not an object");
  if (!isRecord(parsed.answers)) throw malformed("missing answers");

  const answers: Record<string, SystemOneAnswer> = {};
  for (const [name, question] of Object.entries(questions)) {
    const raw = parsed.answers[name];
    if (!isRecord(raw)) throw malformed(`question "${name}" was not answered`);
    if (raw.type !== question.type) {
      throw malformed(`answer "${name}" has type ${String(raw.type)}, expected ${question.type}`);
    }
    answers[name] =
      question.type === "noul"
        ? parseNoul(name, raw)
        : parseChoice(name, raw, Object.keys(question.criteria));
  }

  const usage = parsed.usage;
  if (!isRecord(usage) || !isTokenCount(usage.input_tokens) || !isTokenCount(usage.output_tokens)) {
    throw malformed("missing or invalid usage");
  }
  if (parsed.model !== undefined && parsed.model !== null && typeof parsed.model !== "string") {
    throw malformed("model is not a string");
  }

  return {
    // Each answer was checked above against its question's type.
    answers: answers as SystemOneResult<Q>["answers"],
    usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens },
    model: typeof parsed.model === "string" ? parsed.model : null,
  };
}

function parseNoul(name: string, raw: Record<string, unknown>): NoulAnswer {
  if (!isProbability(raw.noul)) throw malformed(`answer "${name}" noul is not in [0,1]`);
  return { type: "noul", noul: raw.noul };
}

function parseChoice(name: string, raw: Record<string, unknown>, options: string[]): ChoiceAnswer {
  if (typeof raw.choice !== "string" || !options.includes(raw.choice)) {
    throw malformed(`answer "${name}" choice ${JSON.stringify(raw.choice)} is not an option`);
  }
  if (!isProbability(raw.confidence)) {
    throw malformed(`answer "${name}" confidence is not in [0,1]`);
  }
  if (!isRecord(raw.probabilities)) throw malformed(`answer "${name}" has no probabilities`);

  const probabilities: Record<string, number> = {};
  for (const option of options) {
    const p = raw.probabilities[option];
    if (!isProbability(p)) {
      throw malformed(`answer "${name}" probability for "${option}" is missing or not in [0,1]`);
    }
    probabilities[option] = p;
  }
  return { type: "choice", choice: raw.choice, confidence: raw.confidence, probabilities };
}

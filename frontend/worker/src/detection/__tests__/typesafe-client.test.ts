import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  callSystemOne,
  usageFromError,
  MAX_RETRIES,
  type SystemOneQuestion,
} from "../typesafe-client.js";

const API_KEY = "ts-test-secret-key";
const BASE_URL = "https://api.typesafe.ai/v1";

const QUESTIONS: Record<string, SystemOneQuestion> = {
  gate: {
    type: "noul",
    instructions: { detector_criteria: "Flag tool failures.", question: "Does `trace` fail?" },
    criteria: { true: "It fails.", false: "It does not fail." },
  },
  label: {
    type: "choice",
    instructions: { detector_criteria: "Flag tool failures.", question: "Which category?" },
    criteria: {
      tool_error: { what: "A tool errored.", not_for: "Unhelpful data." },
      timeout: { what: "A call timed out.", not_for: "Fast failures." },
      none: { what: "No problem.", not_for: "Any problem." },
    },
  },
};

const OK_BODY = {
  model: "jev-1.13.0",
  answers: {
    gate: { type: "noul", noul: 0.97 },
    label: {
      type: "choice",
      choice: "tool_error",
      confidence: 0.97,
      probabilities: { timeout: 0, none: 0.03, tool_error: 0.97 },
    },
  },
  usage: { input_tokens: 810, output_tokens: 63 },
};

/** Fixed clock, so an HTTP-date retry-after is an exact distance away. */
const NOW = new Date("2026-01-01T00:00:00.000Z");
const HTTP_DATE_IN_2S = new Date(NOW.getTime() + 2_000).toUTCString();

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** fetch stand-in that never settles until its signal aborts, like a hung server. */
function hangingFetch(_url: string, init: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () =>
      reject(new DOMException("The operation was aborted.", "AbortError")),
    );
  });
}

function call(overrides: Partial<Parameters<typeof callSystemOne>[0]> = {}) {
  return callSystemOne({
    apiKey: API_KEY,
    baseUrl: BASE_URL,
    model: "jev-1.13.0",
    state: { trace: { trace_id: "t1", span_count: 0, spans: [] } },
    questions: QUESTIONS,
    deadlineMs: 60_000,
    ...overrides,
  });
}

async function callError(overrides: Partial<Parameters<typeof callSystemOne>[0]> = {}) {
  const err = await call(overrides).then(
    () => {
      throw new Error("expected callSystemOne to throw");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  return err as Error;
}

function withAnswers(answers: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { ...OK_BODY, answers: { ...OK_BODY.answers, ...answers }, ...extra };
}

describe("callSystemOne (stubbed fetch)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe("request", () => {
    it("POSTs model, state and questions to {baseUrl}/systemone with a Bearer key", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, OK_BODY));
      const state = { trace: { trace_id: "t1", span_count: 1, spans: [{ name: "a" }] } };
      await call({ state, baseUrl: `${BASE_URL}/` });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.typesafe.ai/v1/systemone");
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
      expect(JSON.parse(init.body as string)).toEqual({
        model: "jev-1.13.0",
        state,
        questions: QUESTIONS,
      });
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe("success", () => {
    it("returns typed answers, camelCased usage and the echoed model", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, OK_BODY));
      const result = await call();
      expect(result).toEqual({
        answers: OK_BODY.answers,
        usage: { inputTokens: 810, outputTokens: 63 },
        model: "jev-1.13.0",
      });
    });
  });

  describe("strict answer validation", () => {
    const cases: Array<[string, unknown, RegExp]> = [
      ["body is not JSON", "<html>oops</html>", /not JSON/],
      ["answers missing", { model: "jev-1.13.0", usage: OK_BODY.usage }, /missing answers/],
      [
        "a question unanswered",
        { ...OK_BODY, answers: { gate: OK_BODY.answers.gate } },
        /"label" was not answered/,
      ],
      [
        "answer type mismatch",
        withAnswers({ gate: { type: "choice", choice: "x" } }),
        /expected noul/,
      ],
      ["noul above 1", withAnswers({ gate: { type: "noul", noul: 1.2 } }), /noul is not in/],
      [
        "choice not an option",
        withAnswers({ label: { ...OK_BODY.answers.label, choice: "other" } }),
        /is not an option/,
      ],
      [
        "confidence out of range",
        withAnswers({ label: { ...OK_BODY.answers.label, confidence: 1.5 } }),
        /confidence/,
      ],
      [
        "an option missing from probabilities",
        withAnswers({
          label: { ...OK_BODY.answers.label, probabilities: { tool_error: 0.97, none: 0.03 } },
        }),
        /"timeout" is missing/,
      ],
      ["usage missing", withAnswers({}, { usage: undefined }), /usage/],
    ];

    it.each(cases)("fails as a malformed response when %s", async (_name, body, message) => {
      fetchMock.mockResolvedValue(jsonResponse(200, body));
      const err = await callError();
      expect(err.message).toMatch(/malformed response/);
      expect(err.message).toMatch(message);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("usage on a rejected 200", () => {
    it("attaches the billed tokens to the malformed-response error", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, withAnswers({ gate: { type: "noul", noul: 1.2 } })),
      );
      const err = await callError();
      expect(err.message).toMatch(/malformed response/);
      expect(usageFromError(err)).toEqual({ inputTokens: 810, outputTokens: 63 });
    });

    it("has no usage to bill when the body carried none", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, withAnswers({}, { usage: undefined })));
      expect(usageFromError(await callError())).toBeNull();
    });
  });

  describe("terminal errors", () => {
    it("401 carries the error detail, is never retried and never leaks the key", async () => {
      const detail = { error_type: "authentication_error", message: "Check your API key." };
      fetchMock.mockResolvedValue(jsonResponse(401, { detail }));
      const err = await callError();
      expect(err.message).toBe(
        "TypeSafe systemone returned 401: authentication_error - Check your API key.",
      );
      expect(err.message).not.toContain(API_KEY);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("422 pydantic errors carry the field path in the message", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(422, {
          detail: [{ type: "missing", loc: ["body", "questions"], msg: "Field required" }],
        }),
      );
      const err = await callError();
      expect(err.message).toContain("returned 422");
      expect(err.message).toContain("body.questions: Field required");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("a plain-string detail is kept in the message", async () => {
      fetchMock.mockResolvedValue(jsonResponse(404, { detail: "Not Found" }));
      const err = await callError();
      expect(err.message).toBe("TypeSafe systemone returned 404: Not Found");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([500, 404])("%i is terminal, never retried", async (status) => {
      fetchMock.mockResolvedValue(jsonResponse(status, "upstream broke"));
      const err = await callError();
      expect(err.message).toBe(`TypeSafe systemone returned ${status}: upstream broke`);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("a network failure is terminal and has no status", async () => {
      fetchMock.mockRejectedValue(new TypeError("fetch failed"));
      const err = await callError();
      expect(err.message).toBe("TypeSafe request failed: fetch failed");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("429/529 retries", () => {
    it("retries a 429 after retry-after seconds and returns the later success", async () => {
      vi.useFakeTimers();
      fetchMock
        .mockResolvedValueOnce(jsonResponse(429, {}, { "retry-after": "3" }))
        .mockResolvedValueOnce(jsonResponse(200, OK_BODY));
      const p = call();
      await vi.advanceTimersByTimeAsync(2_999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect((await p).answers.gate).toEqual({ type: "noul", noul: 0.97 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("gives up on 529 after MAX_RETRIES retries", async () => {
      vi.useFakeTimers();
      fetchMock.mockImplementation(async () => jsonResponse(529, { detail: "overloaded" }));
      const p = callError();
      await vi.runAllTimersAsync();
      const err = await p;
      expect(err.message).toBe("TypeSafe systemone returned 529: overloaded");
      expect(fetchMock).toHaveBeenCalledTimes(MAX_RETRIES + 1);
    });

    const delayCases: Array<[string, Record<string, string>, number]> = [
      ["an HTTP-date retry-after", { "retry-after": HTTP_DATE_IN_2S }, 2_000],
      ["an unparseable retry-after", { "retry-after": "in a bit" }, 500],
      ["a negative retry-after-ms", { "retry-after-ms": "-250" }, 500],
      ["a non-numeric retry-after-ms", { "retry-after-ms": "later" }, 500],
      ["no retry headers at all", {}, 500],
    ];

    it.each(delayCases)("waits for %s before retrying", async (_name, headers, expectedMs) => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      fetchMock
        .mockResolvedValueOnce(jsonResponse(429, {}, headers))
        .mockResolvedValueOnce(jsonResponse(200, OK_BODY));
      const p = call();
      await vi.advanceTimersByTimeAsync(expectedMs - 1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect((await p).model).toBe("jev-1.13.0");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("doubles the header-less backoff between retries: 500ms, then 1s", async () => {
      vi.useFakeTimers();
      fetchMock
        .mockResolvedValueOnce(jsonResponse(429, {}))
        .mockResolvedValueOnce(jsonResponse(429, {}))
        .mockResolvedValueOnce(jsonResponse(200, OK_BODY));
      const p = call();
      await vi.advanceTimersByTimeAsync(500);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(999);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect((await p).model).toBe("jev-1.13.0");
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("does not wait past the deadline: a retry-after longer than the budget fails now", async () => {
      vi.useFakeTimers();
      fetchMock.mockResolvedValue(jsonResponse(429, {}, { "retry-after": "120" }));
      const err = await callError({ deadlineMs: 60_000 });
      expect(err.message).toBe("TypeSafe systemone returned 429");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("deadline", () => {
    it("caps TOTAL time across retries, not per attempt", async () => {
      vi.useFakeTimers();
      // First attempt is rate limited after 4s; the retry then hangs. The 5s
      // deadline must fire 1.5s into the retry, not 5s after it started.
      fetchMock
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) =>
              setTimeout(() => resolve(jsonResponse(429, {}, { "retry-after-ms": "500" })), 4_000),
            ),
        )
        .mockImplementationOnce(hangingFetch);
      const p = callError({ deadlineMs: 5_000 });
      await vi.advanceTimersByTimeAsync(4_500);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(500);
      const err = await p;
      expect(err.message).toMatch(/timed out/);
    });
  });
});

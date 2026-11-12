import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  MAX_RESPONSE_BYTES,
  callDecisions,
  decisionsUsageFromError,
  DecisionRefusedError,
  MalformedDecisionsResponseError,
  type CallDecisionsOptions,
  type ChoiceQuestion,
  type DecisionsInput,
  type PredicateQuestion,
} from "../openai-decisions-client.js";
import { MAX_RETRIES } from "../typesafe-client.js";

const API_KEY = "sk-test-secret-key";
const BASE_URL = "https://api.openai.com/v1";

const QUESTIONS: { gate: PredicateQuestion; label: ChoiceQuestion } = {
  gate: { type: "predicate", instructions: "Does `trace` fail?" },
  label: {
    type: "choice",
    instructions: "Which category?",
    choices: [
      { value: "tool_error", description: "A tool errored." },
      { value: "timeout", description: "A call timed out." },
      { value: "none", description: "No problem." },
    ],
  },
};

const INPUT: DecisionsInput = [
  {
    role: "user",
    content: [{ type: "input_json", data: { trace: { spans: [] }, detector_criteria: "x" } }],
  },
];

const GATE_ANSWER = { type: "predicate", name: "gate", probability: 0.97 };
const LABEL_ANSWER = {
  type: "choice",
  name: "label",
  choice: "tool_error",
  probabilities: [
    { value: "tool_error", probability: 0.9 },
    { value: "timeout", probability: 0.06 },
    { value: "none", probability: 0.04 },
  ],
  confidence: 0.88,
};

const OK_BODY = {
  answers: [LABEL_ANSWER, GATE_ANSWER],
  usage: {
    input_tokens: 1_000,
    input_tokens_details: { cached_tokens: 600, cache_write_tokens: 100 },
  },
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

type Options = Partial<CallDecisionsOptions<typeof QUESTIONS>>;

function call(overrides: Options = {}) {
  return callDecisions<typeof QUESTIONS>({
    apiKey: API_KEY,
    baseUrl: BASE_URL,
    model: "gpt-6-luna",
    input: INPUT,
    questions: QUESTIONS,
    deadlineMs: 60_000,
    ...overrides,
  });
}

async function callError(overrides: Options = {}) {
  const err = await call(overrides).then(
    () => {
      throw new Error("expected callDecisions to throw");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  return err as Error;
}

function withLabel(label: Record<string, unknown>) {
  return { ...OK_BODY, answers: [GATE_ANSWER, { ...LABEL_ANSWER, ...label }] };
}

describe("callDecisions (stubbed fetch)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("POSTs model, input and the questions as a named list to {baseUrl}/decisions", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, OK_BODY));
    await call({ baseUrl: `${BASE_URL}/` });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/decisions");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
    expect(JSON.parse(init.body as string)).toEqual({
      model: "gpt-6-luna",
      input: INPUT,
      questions: [
        { name: "gate", ...QUESTIONS.gate },
        { name: "label", ...QUESTIONS.label },
      ],
    });
  });

  it("keys the answers by name, maps probabilities by value and reads the cache split", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, OK_BODY));
    expect(await call()).toEqual({
      answers: {
        gate: { type: "predicate", probability: 0.97 },
        label: {
          type: "choice",
          choice: "tool_error",
          confidence: 0.88,
          probabilities: { tool_error: 0.9, timeout: 0.06, none: 0.04 },
        },
      },
      usage: { inputTokens: 1_000, cachedTokens: 600, cacheWriteTokens: 100, outputTokens: 0 },
      model: null,
    });
  });

  it("reads output_tokens and model when the response sends them", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        ...OK_BODY,
        model: "gpt-6-luna-2026-09-30",
        usage: { input_tokens: 40, output_tokens: 3 },
      }),
    );
    const result = await call();
    expect(result.model).toBe("gpt-6-luna-2026-09-30");
    expect(result.usage).toEqual({
      inputTokens: 40,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 3,
    });
  });

  it("gives an option the response leaves out a probability of 0, in the asked order", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        withLabel({
          probabilities: [
            { value: "none", probability: 0.1 },
            { value: "tool_error", probability: 0.9 },
          ],
        }),
      ),
    );
    const { label } = (await call()).answers;
    expect(label.probabilities).toEqual({ tool_error: 0.9, timeout: 0, none: 0.1 });
    expect(Object.keys(label.probabilities)).toEqual(["tool_error", "timeout", "none"]);
  });

  describe("strict answer validation", () => {
    const cases: Array<[string, unknown, RegExp]> = [
      ["body is not JSON", "<html>oops</html>", /not JSON/],
      ["answers missing", { usage: OK_BODY.usage }, /missing answers/],
      ["a question unanswered", { ...OK_BODY, answers: [GATE_ANSWER] }, /"label" was not answered/],
      [
        "answer type mismatch",
        { ...OK_BODY, answers: [{ ...GATE_ANSWER, type: "choice" }, LABEL_ANSWER] },
        /expected predicate/,
      ],
      [
        "probability above 1",
        { ...OK_BODY, answers: [{ ...GATE_ANSWER, probability: 1.2 }, LABEL_ANSWER] },
        /probability is not in/,
      ],
      ["choice not an option", withLabel({ choice: "other" }), /is not an option/],
      ["confidence out of range", withLabel({ confidence: -0.1 }), /confidence/],
      ["probabilities not a list", withLabel({ probabilities: { tool_error: 1 } }), /no prob/],
      [
        "a probability for an option not asked",
        withLabel({ probabilities: [{ value: "loop", probability: 0.5 }] }),
        /not asked/,
      ],
      [
        "an option listed twice",
        withLabel({
          probabilities: [
            { value: "timeout", probability: 0.5 },
            { value: "timeout", probability: 0.4 },
          ],
        }),
        /twice/,
      ],
      [
        "an option probability out of range",
        withLabel({ probabilities: [{ value: "timeout", probability: 2 }] }),
        /"timeout" is not in/,
      ],
      ["usage missing", { answers: OK_BODY.answers }, /usage/],
      [
        "cache tokens above input_tokens",
        {
          ...OK_BODY,
          usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 11 } },
        },
        /exceed input_tokens/,
      ],
      [
        "a negative cached count",
        {
          ...OK_BODY,
          usage: { input_tokens: 10, input_tokens_details: { cached_tokens: -1 } },
        },
        /cached_tokens/,
      ],
      ["a non-string model", { ...OK_BODY, model: 7 }, /model is not a string/],
      [
        "a fractional input_tokens",
        { ...OK_BODY, usage: { input_tokens: 10.5 } },
        /missing or invalid usage/,
      ],
      [
        "an input_tokens too large to store",
        { ...OK_BODY, usage: { input_tokens: 1e308 } },
        /missing or invalid usage/,
      ],
      [
        "an output_tokens above the Int32 limit",
        { ...OK_BODY, usage: { input_tokens: 10, output_tokens: 2_147_483_648 } },
        /invalid usage.output_tokens/,
      ],
    ];

    it.each(cases)("fails as a malformed response when %s", async (_name, body, message) => {
      fetchMock.mockResolvedValue(jsonResponse(200, body));
      const err = await callError();
      expect(err).toBeInstanceOf(MalformedDecisionsResponseError);
      expect(err.message).toMatch(message);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("refusals and billed usage", () => {
    it("fails on a refusal and carries the billed usage", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          ...OK_BODY,
          answers: [GATE_ANSWER, { type: "refusal", name: "label" }],
        }),
      );
      const err = await callError();
      expect(err).toBeInstanceOf(DecisionRefusedError);
      expect(err.message).toBe('OpenAI decisions refused to answer question "label"');
      expect(decisionsUsageFromError(err)).toEqual({
        inputTokens: 1_000,
        cachedTokens: 600,
        cacheWriteTokens: 100,
        outputTokens: 0,
      });
    });

    it("attaches the billed usage to a malformed answer", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, withLabel({ choice: "other" })));
      expect(decisionsUsageFromError(await callError())?.inputTokens).toBe(1_000);
    });

    it("has no usage to bill when the body carried none, or the error is unrelated", async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { answers: OK_BODY.answers }));
      expect(decisionsUsageFromError(await callError())).toBeNull();
      expect(decisionsUsageFromError(new Error("boom"))).toBeNull();
      expect(decisionsUsageFromError("boom")).toBeNull();
    });
  });

  describe("errors and retries", () => {
    it("401 carries OpenAI's error, is never retried and never leaks the key", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(401, {
          error: {
            message: "Incorrect API key provided.",
            type: "invalid_request_error",
            code: "invalid_api_key",
          },
        }),
      );
      const err = await callError();
      expect(err.message).toBe(
        "OpenAI decisions returned 401: invalid_api_key - Incorrect API key provided.",
      );
      expect(err.message).not.toContain(API_KEY);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("a 400 with a plain body is terminal and keeps the body", async () => {
      fetchMock.mockResolvedValue(jsonResponse(400, "bad request"));
      const err = await callError();
      expect(err.message).toBe("OpenAI decisions returned 400: bad request");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    describe("response size", () => {
      const KIB = new Uint8Array(1024).fill(0x20);

      /** A body that never ends on its own, counting the chunks pulled from it. */
      function endlessBody(status: number) {
        const stream = { pulled: 0, cancelled: false };
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            stream.pulled++;
            controller.enqueue(KIB);
          },
          cancel() {
            stream.cancelled = true;
          },
        });
        return { stream, response: new Response(body, { status }) };
      }

      it("stops reading and cancels a body that goes over the limit, without retrying", async () => {
        const { stream, response } = endlessBody(200);
        fetchMock.mockResolvedValue(response);

        const err = await callError();

        expect(err.message).toBe(
          `OpenAI decisions request failed: response body is over the ${MAX_RESPONSE_BYTES}-byte limit`,
        );
        expect(stream.cancelled).toBe(true);
        // Read up to the limit and one chunk past it, never the whole stream.
        expect(stream.pulled * 1024).toBeLessThanOrEqual(MAX_RESPONSE_BYTES + 2 * 1024);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      it("bounds an error body too, keeping its status: a 400 stays terminal", async () => {
        const { stream, response } = endlessBody(400);
        fetchMock.mockResolvedValue(response);

        const err = await callError();

        expect(err.message).toBe("OpenAI decisions returned 400");
        expect(stream.cancelled).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      it("still retries a 503 whose oversized body was cut off", async () => {
        vi.useFakeTimers();
        const { stream, response } = endlessBody(503);
        fetchMock.mockResolvedValueOnce(response).mockResolvedValueOnce(jsonResponse(200, OK_BODY));

        const p = call();
        await vi.runAllTimersAsync();

        expect((await p).answers.gate.probability).toBe(0.97);
        expect(stream.cancelled).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });

      it("gives up on an oversized 5xx with its status after MAX_RETRIES retries", async () => {
        vi.useFakeTimers();
        const streams: { cancelled: boolean }[] = [];
        fetchMock.mockImplementation(async () => {
          const { stream, response } = endlessBody(500);
          streams.push(stream);
          return response;
        });

        const p = callError();
        await vi.runAllTimersAsync();
        const err = await p;

        expect(err.message).toBe("OpenAI decisions returned 500");
        expect(fetchMock).toHaveBeenCalledTimes(MAX_RETRIES + 1);
        expect(streams.every((s) => s.cancelled)).toBe(true);
      });

      it("fails on a declared Content-Length over the limit before reading the body", async () => {
        const { stream, response } = endlessBody(200);
        response.headers.set("content-length", String(MAX_RESPONSE_BYTES + 1));
        fetchMock.mockResolvedValue(response);

        const err = await callError();

        expect(err.message).toMatch(/over the \d+-byte limit/);
        expect(stream.cancelled).toBe(true);
        // Only the stream's own start-up pull: nothing was read past the header.
        expect(stream.pulled).toBeLessThanOrEqual(1);
      });

      it("reads a body that arrives in many chunks, under the limit", async () => {
        const text = JSON.stringify(OK_BODY);
        const bytes = new TextEncoder().encode(text);
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
            controller.close();
          },
        });
        fetchMock.mockResolvedValue(new Response(body, { status: 200 }));

        const result = await call();

        expect(result.answers.gate.probability).toBe(0.97);
        expect(result.answers.label.choice).toBe("tool_error");
      });
    });

    it("a network failure is terminal", async () => {
      fetchMock.mockRejectedValue(new TypeError("fetch failed"));
      const err = await callError();
      expect(err.message).toBe("OpenAI decisions request failed: fetch failed");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("retries a 429 after retry-after-ms and returns the later success", async () => {
      vi.useFakeTimers();
      fetchMock
        .mockResolvedValueOnce(jsonResponse(429, {}, { "retry-after-ms": "300" }))
        .mockResolvedValueOnce(jsonResponse(200, OK_BODY));
      const p = call();
      await vi.advanceTimersByTimeAsync(299);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect((await p).answers.gate.probability).toBe(0.97);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each([500, 503])("gives up on %i after MAX_RETRIES retries", async (status) => {
      vi.useFakeTimers();
      fetchMock.mockImplementation(async () =>
        jsonResponse(status, { error: { message: "overloaded" } }),
      );
      const p = callError();
      await vi.runAllTimersAsync();
      const err = await p;
      expect(err.message).toBe(`OpenAI decisions returned ${status}: overloaded`);
      expect(fetchMock).toHaveBeenCalledTimes(MAX_RETRIES + 1);
    });

    it("does not wait past the deadline: a retry-after longer than the budget fails now", async () => {
      fetchMock.mockResolvedValue(jsonResponse(429, {}, { "retry-after": "120" }));
      const err = await callError({ deadlineMs: 60_000 });
      expect(err.message).toBe("OpenAI decisions returned 429");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("times out a hung request at the deadline", async () => {
      vi.useFakeTimers();
      fetchMock.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("The operation was aborted.", "AbortError")),
            );
          }),
      );
      const p = callError({ deadlineMs: 5_000 });
      await vi.advanceTimersByTimeAsync(5_000);
      expect((await p).message).toBe("OpenAI decisions timed out after 5000ms (model=gpt-6-luna)");
    });
  });
});

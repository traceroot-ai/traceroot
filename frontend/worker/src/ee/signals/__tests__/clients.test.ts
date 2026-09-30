import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockComplete, mockSystemOne, mockFetchProviderConfig } = vi.hoisted(() => ({
  mockComplete: vi.fn(),
  mockSystemOne: vi.fn(),
  mockFetchProviderConfig: vi.fn(),
}));
vi.mock("../../../detection/traced-complete.js", () => ({ tracedComplete: mockComplete }));
vi.mock("../../../detection/typesafe-client.js", async (orig) => ({
  ...(await orig<typeof import("../../../detection/typesafe-client.js")>()),
  callSystemOne: mockSystemOne,
}));
vi.mock("@traceroot/core/model-resolver", async (orig) => ({
  ...(await orig<typeof import("@traceroot/core/model-resolver")>()),
  fetchProviderConfig: mockFetchProviderConfig,
}));

import { embedTexts } from "../embedding.js";
import {
  createChatModels,
  createJevModels,
  findJevProvider,
  fitAnswers,
  parseAssignAnswer,
  parseSignalText,
} from "../models.js";
import type { ModelUsage } from "../types.js";

const mockFetch = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mockFetch);
});
afterEach(() => vi.unstubAllGlobals());

function jsonResponse(status: number, body: unknown) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) };
}

describe("embedTexts", () => {
  it("batches by 100, keeps input order by index, and sums tokens", async () => {
    mockFetch.mockImplementation(async (_url: string, init: { body: string }) => {
      const input = JSON.parse(init.body).input as string[];
      // Return rows out of order to prove the index is honoured.
      const data = input.map((t, i) => ({ index: i, embedding: [Number(t)] })).reverse();
      return jsonResponse(200, { data, usage: { prompt_tokens: input.length } });
    });
    const texts = Array.from({ length: 150 }, (_, i) => String(i));
    const res = await embedTexts(texts, "sk-test");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(res.vectors.map((v) => v[0])).toEqual(texts.map(Number));
    expect(res.inputTokens).toBe(150);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/embeddings");
    expect(init.headers.Authorization).toBe("Bearer sk-test");
    expect(JSON.parse(init.body).model).toBe("text-embedding-3-small");
  });

  it("retries a 429 and gives up on a 400 without leaking the key", async () => {
    vi.useFakeTimers();
    mockFetch
      .mockResolvedValueOnce(jsonResponse(429, { error: { message: "slow down" } }))
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ index: 0, embedding: [1] }] }));
    const p = embedTexts(["a"], "sk-secret");
    await vi.runAllTimersAsync();
    expect((await p).vectors).toEqual([[1]]);
    vi.useRealTimers();

    mockFetch.mockResolvedValueOnce(jsonResponse(400, { error: { message: "bad input" } }));
    const err = await embedTexts(["a"], "sk-secret").catch((e: Error) => e);
    expect(String(err)).toContain("returned 400: bad input");
    expect(String(err)).not.toContain("sk-secret");
  });

  it("rejects a response with the wrong number of vectors or non-numeric vectors", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { data: [] }));
    await expect(embedTexts(["a"], "k")).rejects.toThrow("0 vectors for 1 inputs");
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { data: [{ embedding: ["x"] }] }));
    await expect(embedTexts(["a"], "k")).rejects.toThrow("not a number array");
  });

  it("rejects a response with a repeated index", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(200, {
        data: [
          { index: 0, embedding: [1] },
          { index: 0, embedding: [2] },
        ],
      }),
    );
    await expect(embedTexts(["a", "b"], "k")).rejects.toThrow("missing or repeated index 0");
  });

  it("reports a network failure", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNRESET"));
    await expect(embedTexts(["a"], "k")).rejects.toThrow("embedding request failed: ECONNRESET");
  });
});

describe("tool argument parsing", () => {
  it("accepts a complete signal text and trims it", () => {
    expect(parseSignalText({ title: " T ", covers: " C ", excludes: "" })).toEqual({
      title: "T",
      covers: "C",
      excludes: "",
    });
    expect(parseSignalText({ title: "", covers: "C", excludes: "" })).toBe(null);
    expect(parseSignalText({ title: "T", covers: "C" })).toBe(null);
    expect(parseSignalText("T")).toBe(null);
  });

  it("reads an assignment and drops a malformed new signal", () => {
    expect(parseAssignAnswer({ choice: "s1", reason: "r", new_signal: null })).toEqual({
      choice: "s1",
      reason: "r",
      newSignal: null,
    });
    expect(parseAssignAnswer({ choice: "none", new_signal: { title: "T" } })).toEqual({
      choice: "none",
      reason: "",
      newSignal: null,
    });
    expect(parseAssignAnswer({ choice: "" })).toBe(null);
  });

  it("fits validation answers to the number of texts", () => {
    expect(fitAnswers([true, false, true], 2)).toEqual([true, false]);
    expect(fitAnswers([true], 3)).toEqual([true, false, false]);
    expect(fitAnswers("yes", 1)).toBe(null);
  });
});

function toolResponse(name: string, args: unknown, extra: Record<string, unknown> = {}) {
  return {
    stopReason: "toolUse",
    content: [{ type: "toolCall", name, arguments: args }],
    model: "gpt-5.6-luna",
    provider: "openai",
    usage: { input: 100, output: 20, cost: { total: 0 } },
    ...extra,
  };
}

describe("chat models", () => {
  it("calls the benchmarked model with the key and records usage as system usage", async () => {
    mockComplete.mockResolvedValueOnce(
      toolResponse("submit_assignment", { choice: "s1", reason: "same fix", new_signal: null }),
    );
    const usage: ModelUsage[] = [];
    const chat = createChatModels("sk-test", usage);
    const answer = await chat.assign("hit", []);
    expect(answer).toEqual({ choice: "s1", reason: "same fix", newSignal: null });
    const [model, ctx, opts] = mockComplete.mock.calls[0];
    expect(model.id).toBe("gpt-5.6-luna");
    expect(ctx.tools[0].name).toBe("submit_assignment");
    expect(opts).toMatchObject({ apiKey: "sk-test", reasoningEffort: "medium" });
    expect(usage).toEqual([
      {
        model: "gpt-5.6-luna",
        provider: "openai",
        isByok: false,
        inputTokens: 100,
        outputTokens: 20,
        cost: 0,
      },
    ]);
  });

  it("retries once when the model answers in text, then succeeds", async () => {
    mockComplete
      .mockResolvedValueOnce({
        stopReason: "stop",
        content: [{ type: "text", text: "hm" }],
        usage: {},
      })
      .mockResolvedValueOnce(
        toolResponse("submit_signal", { title: "T", covers: "C", excludes: "E" }),
      );
    const chat = createChatModels("k", []);
    await expect(chat.write("hit", [])).resolves.toEqual({
      title: "T",
      covers: "C",
      excludes: "E",
    });
    const retryMessages = mockComplete.mock.calls[1][1].messages;
    expect(retryMessages.at(-1).content).toContain("must call submit_signal");
  });

  it("fails after two unusable answers, and at once on a provider error", async () => {
    mockComplete.mockResolvedValue(toolResponse("submit_validation", { accepted: "yes" }));
    const chat = createChatModels("k", []);
    await expect(chat.validate("c", "e", ["a"])).rejects.toThrow("malformed tool arguments");

    mockComplete.mockReset();
    mockComplete.mockResolvedValueOnce({
      stopReason: "error",
      errorMessage: "401",
      content: [],
      usage: {},
    });
    await expect(chat.validate("c", "e", ["a"])).rejects.toThrow("401");
    expect(mockComplete).toHaveBeenCalledOnce();
  });

  it("returns one validation answer per text", async () => {
    mockComplete.mockResolvedValueOnce(toolResponse("submit_validation", { accepted: [true] }));
    await expect(createChatModels("k", []).validate("c", "e", ["a", "b"])).resolves.toEqual([
      true,
      false,
    ]);
  });

  it("treats an aborted call as a timeout", async () => {
    mockComplete.mockResolvedValueOnce({ stopReason: "aborted", content: [], usage: {} });
    await expect(createChatModels("k", []).write("hit", [])).rejects.toThrow("timed out");
  });
});

describe("Jev models", () => {
  const config = { adapter: "typesafe", key: "ts-key", baseUrl: null, config: null };

  it("asks one Choice question over the candidates and records BYOK usage", async () => {
    mockSystemOne.mockResolvedValueOnce({
      answers: {
        signal: {
          type: "choice",
          choice: "s1",
          confidence: 0.9,
          probabilities: { s1: 0.93, none: 0.07 },
        },
      },
      usage: { inputTokens: 50, outputTokens: 1 },
      model: "jev-1.13.0",
    });
    const usage: ModelUsage[] = [];
    const jev = createJevModels(config, usage);
    const answer = await jev.assign("hit", [
      {
        label: "s1",
        signalId: "a",
        title: "T",
        covers: "C",
        excludes: "E",
        example: "x",
        status: "open",
        hitCount: 1,
        criteriaVersion: 1,
      },
    ]);
    expect(answer).toEqual({ choice: "s1", probabilities: { s1: 0.93, none: 0.07 } });
    const call = mockSystemOne.mock.calls[0][0];
    expect(call).toMatchObject({
      apiKey: "ts-key",
      baseUrl: "https://api.typesafe.ai/v1",
      state: { hit: "hit" },
    });
    expect(Object.keys(call.questions.signal.criteria)).toEqual(["s1", "none"]);
    expect(usage[0]).toMatchObject({ provider: "typesafe", isByok: true, inputTokens: 50 });
  });

  it("validates with one yes/no per text at 0.5", async () => {
    mockSystemOne.mockResolvedValueOnce({
      answers: { hit_0: { type: "noul", noul: 0.8 }, hit_1: { type: "noul", noul: 0.49 } },
      usage: { inputTokens: 5, outputTokens: 2 },
      model: null,
    });
    const jev = createJevModels({ ...config, baseUrl: "https://ts.example/v1" }, []);
    await expect(jev.validate("C", "E", ["a", "b"])).resolves.toEqual([true, false]);
    const call = mockSystemOne.mock.calls[0][0];
    expect(call.baseUrl).toBe("https://ts.example/v1");
    expect(call.state).toEqual({ criteria: "covers: C\nexcludes: E", hit_0: "a", hit_1: "b" });
  });

  it("records the tokens of a billed response it rejects", async () => {
    mockSystemOne.mockRejectedValueOnce(
      Object.assign(new Error("malformed"), { usage: { inputTokens: 9, outputTokens: 1 } }),
    );
    const usage: ModelUsage[] = [];
    await expect(createJevModels(config, usage).validate("c", "e", ["a"])).rejects.toThrow(
      "malformed",
    );
    expect(usage).toHaveLength(1);
    expect(usage[0].inputTokens).toBe(9);
  });
});

describe("findJevProvider", () => {
  it("returns the first enabled TypeSafe provider that resolves", async () => {
    const db = {
      modelProvider: {
        findMany: vi.fn(async () => [{ provider: "old" }, { provider: "new" }]),
      },
    };
    mockFetchProviderConfig
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ adapter: "typesafe", key: "k" });
    await expect(findJevProvider(db as never, "ws")).resolves.toMatchObject({ key: "k" });
    expect(db.modelProvider.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: "ws", enabled: true, adapter: "typesafe" } }),
    );
  });

  it("returns null when the workspace has none", async () => {
    const db = { modelProvider: { findMany: vi.fn(async () => []) } };
    await expect(findJevProvider(db as never, "ws")).resolves.toBe(null);
  });
});

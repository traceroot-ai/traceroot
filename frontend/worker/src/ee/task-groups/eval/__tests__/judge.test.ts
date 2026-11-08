import { beforeEach, describe, expect, it, vi } from "vitest";

const complete = vi.hoisted(() => vi.fn());
vi.mock("../../../../detection/traced-complete.js", () => ({ tracedComplete: complete }));
vi.mock("@traceroot/core/model-resolver", () => ({
  resolvePiModel: () => ({ id: "model", provider: "openai" }),
}));
vi.mock("@traceroot/core/llm-providers", () => ({ LLMAdapter: { OPENAI: "openai" } }));

import { createModelJudge } from "../judge.js";

const toolCall = (name: string, args: Record<string, unknown>, cost = 0.001) => ({
  content: [{ type: "toolCall", name, arguments: args }],
  usage: { input: 100, output: 10, cost: { total: cost } },
});
const candidates = [
  { label: "A", title: "Flights", covers: "Booking flights", example: "Book a flight." },
];

beforeEach(() => complete.mockReset());

describe("createModelJudge", () => {
  it("returns the label the model chose and counts the call and its cost", async () => {
    complete.mockResolvedValue(toolCall("submit_choice", { choice: "A" }));
    const { judge, usage } = createModelJudge("key");
    expect(await judge.choose("Rebook a flight.", candidates)).toBe("A");
    expect(usage.calls).toBe(1);
    expect(usage.costUsd).toBeCloseTo(0.001);
    // The summary is sent as data, together with the candidates.
    const user = complete.mock.calls[0][1].messages[0].content as string;
    expect(user).toContain("Rebook a flight.");
    expect(user).toContain("[A] Flights");
  });

  it("treats a missing choice as none", async () => {
    complete.mockResolvedValue(toolCall("submit_choice", {}));
    const { judge } = createModelJudge("key");
    expect(await judge.choose("x", candidates)).toBe("none");
  });

  it("describes a new group with a bounded title and description", async () => {
    complete.mockResolvedValue(
      toolCall("submit_group", { title: "T".repeat(100), covers: "C".repeat(500) }),
    );
    const { judge } = createModelJudge("key");
    const text = await judge.describe("Book a hotel.", []);
    expect(text.title).toHaveLength(60);
    expect(text.covers).toHaveLength(240);
    expect(complete.mock.calls[0][1].messages[0].content).toContain("(none yet)");
  });

  it("asks again when the model answers in text, and gives up after three tries", async () => {
    complete.mockResolvedValue({ content: [{ type: "text", text: "A" }], usage: {} });
    const { judge, usage } = createModelJudge("key");
    await expect(judge.choose("x", candidates)).rejects.toThrow(/no tool call/);
    expect(usage.calls).toBe(3);
  });

  it("recovers when the second try uses the tool", async () => {
    complete
      .mockResolvedValueOnce({ content: [{ type: "text", text: "A" }], usage: {} })
      .mockResolvedValueOnce(toolCall("submit_choice", { choice: "A" }));
    const { judge } = createModelJudge("key");
    expect(await judge.choose("x", candidates)).toBe("A");
  });
});

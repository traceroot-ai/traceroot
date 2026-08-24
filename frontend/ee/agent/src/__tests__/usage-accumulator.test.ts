import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AgentEvent } from "@earendil-works/pi-agent-core";

const mocks = vi.hoisted(() => ({
  calculateCost: vi.fn(async () => 0.42),
}));

vi.mock("@traceroot/core", () => ({
  calculateCost: mocks.calculateCost,
}));

import { UsageAccumulator } from "../usage-accumulator.js";

const messageEnd = (usage: Record<string, unknown>, model = "test-model"): AgentEvent =>
  ({
    type: "message_end",
    message: {
      model,
      provider: "test-provider",
      usage,
      stopReason: "stop",
    } as never,
  }) as AgentEvent;

describe("UsageAccumulator", () => {
  beforeEach(() => {
    mocks.calculateCost.mockClear();
  });

  it("sums usage across message_end events and uses the stream-reported cost", async () => {
    const acc = new UsageAccumulator();
    acc.onEvent(messageEnd({ input: 10, output: 5, cost: { total: 0.01 } }));
    acc.onEvent(messageEnd({ input: 20, output: 15, cost: { total: 0.02 } }));

    const usage = await acc.toTokenUsage(false);
    expect(usage).toEqual({
      model: "test-model",
      provider: "test-provider",
      isByok: false,
      inputTokens: 30,
      outputTokens: 20,
      cost: expect.closeTo(0.03),
    });
    expect(mocks.calculateCost).not.toHaveBeenCalled();
  });

  it("falls back to the pricing table when the stream reports zero cost", async () => {
    const acc = new UsageAccumulator();
    acc.onEvent(messageEnd({ input: 10, output: 5, cacheRead: 2, cacheWrite: 1 }));

    const usage = await acc.toTokenUsage(true);
    expect(mocks.calculateCost).toHaveBeenCalledWith("test-model", 10, 5, 2, 1);
    expect(usage).toMatchObject({ isByok: true, cost: 0.42 });
  });

  it("warns when pricing is missing so the run is visibly unbilled", async () => {
    mocks.calculateCost.mockResolvedValueOnce(0);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const acc = new UsageAccumulator();
    acc.onEvent(messageEnd({ input: 10, output: 5 }));

    const usage = await acc.toTokenUsage(false);
    expect(usage?.cost).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("test-model"));
    warnSpy.mockRestore();
  });

  it("survives a failing pricing lookup with a zero-cost fallback", async () => {
    mocks.calculateCost.mockRejectedValueOnce(new Error("pricing db down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const acc = new UsageAccumulator();
    acc.onEvent(messageEnd({ input: 10, output: 5 }));

    const usage = await acc.toTokenUsage(false);
    expect(usage).toMatchObject({ inputTokens: 10, outputTokens: 5, cost: 0 });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("carries the last reported cumulative session total", async () => {
    const acc = new UsageAccumulator();
    acc.onEvent(messageEnd({ input: 10, output: 5, totalTokens: 100, cost: { total: 0.01 } }));
    acc.onEvent(messageEnd({ input: 20, output: 15, totalTokens: 250, cost: { total: 0.02 } }));

    const usage = await acc.toTokenUsage(false);
    expect(usage?.totalTokens).toBe(250);
  });

  it("returns undefined when the run produced no model (nothing to bill)", async () => {
    const acc = new UsageAccumulator();
    expect(await acc.toTokenUsage(false)).toBeUndefined();
    expect(mocks.calculateCost).not.toHaveBeenCalled();
  });

  it("ignores events other than message_end", async () => {
    const acc = new UsageAccumulator();
    acc.onEvent({ type: "turn_start" } as AgentEvent);
    acc.onEvent({
      type: "message_update",
      message: {} as never,
      assistantMessageEvent: { type: "text_delta", delta: "x" } as never,
    } as AgentEvent);
    expect(await acc.toTokenUsage(false)).toBeUndefined();
  });
});

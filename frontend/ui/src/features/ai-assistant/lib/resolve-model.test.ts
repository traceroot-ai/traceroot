import { describe, expect, it } from "vitest";
import { chatModels, isChatModel, pickDefaultModel, type ResolvedModel } from "./resolve-model";

function model(id: string, adapter: string): ResolvedModel {
  return { id, label: id, provider: `my-${adapter}`, adapter, source: "byok", supported: true };
}

describe("isChatModel", () => {
  it("rejects a TypeSafe model and the OpenAI decision alias, and keeps chat models", () => {
    expect(isChatModel(model("jev-1.13.0", "typesafe"))).toBe(false);
    expect(isChatModel(model("gpt-6-luna-decisions", "openai"))).toBe(false);
    expect(isChatModel(model("gpt-6-luna", "openai"))).toBe(true);
    expect(isChatModel(model("claude-opus-5-5", "anthropic"))).toBe(true);
  });
});

describe("chatModels", () => {
  it("keeps order, so the default pick skips a decision alias listed first", () => {
    const models = [
      model("gpt-6-luna-decisions", "openai"),
      model("jev-1.13.0", "typesafe"),
      model("gpt-6-luna", "openai"),
    ];
    expect(chatModels(models).map((m) => m.id)).toEqual(["gpt-6-luna"]);
    expect(pickDefaultModel(models)?.id).toBe("gpt-6-luna-decisions");
    expect(pickDefaultModel(chatModels(models))?.id).toBe("gpt-6-luna");
  });

  it("leaves nothing to pick when only decision models are configured", () => {
    const models = [model("gpt-6-luna-decisions", "openai"), model("jev-1.13.0", "typesafe")];
    expect(pickDefaultModel(chatModels(models))).toBeUndefined();
  });
});

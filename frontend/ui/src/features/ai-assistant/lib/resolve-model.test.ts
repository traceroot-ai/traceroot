import { describe, expect, it } from "vitest";
import { RCA_SYSTEM_DEFAULT_MODEL_ID } from "@traceroot/core";
import { pickDefaultModel, type ResolvedModel } from "./resolve-model";

const sys = (id: string, adapter: string): ResolvedModel => ({
  id,
  label: id,
  provider: "",
  adapter,
  source: "system",
});

describe("pickDefaultModel", () => {
  it("prefers the named RCA default over catalog order within the system provider", () => {
    const models = [
      sys("claude-opus-4-8", "anthropic"),
      sys(RCA_SYSTEM_DEFAULT_MODEL_ID, "anthropic"),
    ];
    expect(pickDefaultModel(models)?.id).toBe(RCA_SYSTEM_DEFAULT_MODEL_ID);
  });

  it("falls back to the provider's first model when the named default is absent", () => {
    expect(pickDefaultModel([sys("gpt-5.5", "openai"), sys("gpt-5.4", "openai")])?.id).toBe(
      "gpt-5.5",
    );
  });

  it("keeps BYOK precedence over the system default", () => {
    const byok: ResolvedModel = {
      ...sys("claude-opus-4-8", "anthropic"),
      source: "byok",
      provider: "mine",
    };
    expect(pickDefaultModel([byok, sys(RCA_SYSTEM_DEFAULT_MODEL_ID, "anthropic")])).toBe(byok);
  });
});

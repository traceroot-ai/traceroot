import { describe, expect, it, vi } from "vitest";
import { ADAPTER_CONFIG, ADAPTER_MODELS, LLMAdapter } from "@traceroot/core";

// `settingsOnlyReason` looks both tables up by adapter name. Writable copies of
// the real ones, so that every entry the types allow can be put behind a name.
vi.mock("@traceroot/core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@traceroot/core")>();
  return {
    ...core,
    ADAPTER_CONFIG: { ...core.ADAPTER_CONFIG },
    ADAPTER_MODELS: { ...core.ADAPTER_MODELS },
  };
});

import { isInlineConfigurable, settingsOnlyReason } from "./ModelProviderBlock";

type Credential = { credentialType: "api-key" | "aws"; requiresBaseUrl: boolean };

const key: Credential = { credentialType: "api-key", requiresBaseUrl: false };
const keyAndUrl: Credential = { credentialType: "api-key", requiresBaseUrl: true };
const aws: Credential = { credentialType: "aws", requiresBaseUrl: false };
const awsAndUrl: Credential = { credentialType: "aws", requiresBaseUrl: true };

const noList = undefined;
const emptyList: [] = [];
const aList = [{ id: "a-model", label: "a-model" }];

/**
 * Every entry the two signatures allow — each credential shape, and a catalogue
 * that is missing, empty or has a model in it — with what the step makes of it.
 * The two functions state the credential half of one rule, so they have to
 * agree on every row: no reason exactly when the adapter is offered inline.
 */
const RULE = [
  { config: key, catalogue: noList, inline: false, reason: "model-list" },
  { config: key, catalogue: emptyList, inline: false, reason: "model-list" },
  { config: key, catalogue: aList, inline: true, reason: null },
  { config: keyAndUrl, catalogue: noList, inline: false, reason: "more-than-a-key" },
  { config: keyAndUrl, catalogue: emptyList, inline: false, reason: "more-than-a-key" },
  { config: keyAndUrl, catalogue: aList, inline: false, reason: "more-than-a-key" },
  { config: aws, catalogue: noList, inline: false, reason: "more-than-a-key" },
  { config: aws, catalogue: emptyList, inline: false, reason: "more-than-a-key" },
  { config: aws, catalogue: aList, inline: false, reason: "more-than-a-key" },
  { config: awsAndUrl, catalogue: noList, inline: false, reason: "more-than-a-key" },
  { config: awsAndUrl, catalogue: emptyList, inline: false, reason: "more-than-a-key" },
  { config: awsAndUrl, catalogue: aList, inline: false, reason: "more-than-a-key" },
] as const;

const catalogueState = (catalogue: readonly unknown[] | undefined) =>
  catalogue === undefined ? noList : catalogue.length === 0 ? emptyList : aList;

describe("the inline rule and the reason it gives, over every typed entry", () => {
  it("offers an adapter inline only when its key is the whole credential and it has models", () => {
    for (const row of RULE) {
      expect(isInlineConfigurable(row.config, row.catalogue), JSON.stringify(row)).toBe(row.inline);
    }
    // No entry at all is never inline, whatever the catalogue.
    for (const catalogue of [noList, emptyList, aList]) {
      expect(isInlineConfigurable(undefined, catalogue)).toBe(false);
    }
  });

  it("names the half of that rule each excluded adapter fails, and none for an inline one", () => {
    const adapter = LLMAdapter.OPENAI;
    const realConfig = ADAPTER_CONFIG[adapter];
    const realModels = ADAPTER_MODELS[adapter];
    try {
      for (const row of RULE) {
        ADAPTER_CONFIG[adapter] = { label: "An adapter", ...row.config };
        if (row.catalogue === undefined) delete ADAPTER_MODELS[adapter];
        else ADAPTER_MODELS[adapter] = [...row.catalogue];

        expect(settingsOnlyReason(adapter), JSON.stringify(row)).toBe(row.reason);
      }
    } finally {
      ADAPTER_CONFIG[adapter] = realConfig;
      ADAPTER_MODELS[adapter] = realModels;
    }
  });

  it("gives every adapter in today's tables the reason its own entry earns", () => {
    // The same table, read the other way: each real adapter lands on the row
    // its entry matches, including the internal `typesafe` one no surface offers.
    for (const adapter of Object.values(LLMAdapter)) {
      const { credentialType, requiresBaseUrl } = ADAPTER_CONFIG[adapter];
      const catalogue = catalogueState(ADAPTER_MODELS[adapter]);
      const row = RULE.find(
        (candidate) =>
          candidate.config.credentialType === credentialType &&
          candidate.config.requiresBaseUrl === requiresBaseUrl &&
          candidate.catalogue === catalogue,
      );
      expect(row, adapter).toBeDefined();
      expect(settingsOnlyReason(adapter), adapter).toBe(row!.reason);
      expect(isInlineConfigurable(ADAPTER_CONFIG[adapter], ADAPTER_MODELS[adapter]), adapter).toBe(
        row!.inline,
      );
    }
  });
});

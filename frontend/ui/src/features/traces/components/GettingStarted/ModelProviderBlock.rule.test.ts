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

import {
  acceptsFreeTextModel,
  isInlineConfigurable,
  SEEDED_MODELS,
  seedFor,
  settingsOnlyReason,
} from "./ModelProviderBlock";

type Credential = { credentialType: "api-key" | "aws"; requiresBaseUrl: boolean };

const key: Credential = { credentialType: "api-key", requiresBaseUrl: false };
const keyAndUrl: Credential = { credentialType: "api-key", requiresBaseUrl: true };
const aws: Credential = { credentialType: "aws", requiresBaseUrl: false };
const awsAndUrl: Credential = { credentialType: "aws", requiresBaseUrl: true };

const noList = undefined;
const emptyList: [] = [];
const aList = [{ id: "a-model", label: "a-model" }];

/**
 * Every entry the policy accepts — each credential shape, a list of models to
 * seed that is missing, empty or has a model in it, and whether the adapter
 * collects a free-text model ID inline — with what the step makes of it.
 * The two functions state the halves of one rule, so they have to agree on
 * every row: no reason exactly when the adapter is offered inline.
 */
const RULE = [
  { config: key, catalogue: noList, freeTextModel: false, inline: false, reason: "model-list" },
  { config: key, catalogue: emptyList, freeTextModel: false, inline: false, reason: "model-list" },
  { config: key, catalogue: aList, freeTextModel: false, inline: true, reason: null },
  { config: key, catalogue: noList, freeTextModel: true, inline: true, reason: null },
  { config: key, catalogue: emptyList, freeTextModel: true, inline: true, reason: null },
  { config: key, catalogue: aList, freeTextModel: true, inline: true, reason: null },
  ...[false, true].flatMap((freeTextModel) =>
    [keyAndUrl, aws, awsAndUrl].flatMap((config) =>
      [noList, emptyList, aList].map((catalogue) => ({
        config,
        catalogue,
        freeTextModel,
        inline: false,
        reason: "more-than-a-key" as const,
      })),
    ),
  ),
] as const;

const catalogueState = (catalogue: readonly unknown[] | undefined) =>
  catalogue === undefined ? noList : catalogue.length === 0 ? emptyList : aList;

describe("the inline rule and the reason it gives, over every typed entry", () => {
  it("offers an adapter inline only when its key is the whole credential and it has models or accepts free-text input", () => {
    for (const row of RULE) {
      expect(
        isInlineConfigurable(row.config, row.catalogue, row.freeTextModel),
        JSON.stringify(row),
      ).toBe(row.inline);
    }
    // No entry at all is never inline, whatever the catalogue or free-text support.
    for (const catalogue of [noList, emptyList, aList]) {
      for (const freeTextModel of [false, true]) {
        expect(isInlineConfigurable(undefined, catalogue, freeTextModel)).toBe(false);
      }
    }
  });

  it("names the half of that rule each excluded adapter fails, and none for an inline one", () => {
    for (const [adapter, freeTextModel] of [
      [LLMAdapter.OPENAI, false],
      [LLMAdapter.OPENROUTER, true],
    ] as const) {
      const realConfig = ADAPTER_CONFIG[adapter];
      const realModels = ADAPTER_MODELS[adapter];
      const realSeeds = SEEDED_MODELS[adapter];
      try {
        for (const row of RULE.filter((r) => r.freeTextModel === freeTextModel)) {
          ADAPTER_CONFIG[adapter] = { label: "An adapter", ...row.config };
          if (row.catalogue === undefined) {
            delete ADAPTER_MODELS[adapter];
            delete SEEDED_MODELS[adapter];
          } else {
            ADAPTER_MODELS[adapter] = [...row.catalogue];
            SEEDED_MODELS[adapter] = row.catalogue.map((model) => model.id);
          }

          expect(settingsOnlyReason(adapter), `${adapter}: ${JSON.stringify(row)}`).toBe(
            row.reason,
          );
        }
      } finally {
        ADAPTER_CONFIG[adapter] = realConfig;
        ADAPTER_MODELS[adapter] = realModels;
        SEEDED_MODELS[adapter] = realSeeds;
      }
    }
  });

  it("gives every adapter in today's tables the reason its own entry earns", () => {
    // The same table, read the other way: each real adapter lands on the row
    // its entry matches, including OpenRouter (free-text) and the internal `typesafe` adapter.
    for (const adapter of Object.values(LLMAdapter)) {
      const { credentialType, requiresBaseUrl } = ADAPTER_CONFIG[adapter];
      const catalogue = catalogueState(seedFor(adapter));
      const freeTextModel = acceptsFreeTextModel(adapter);
      const row = RULE.find(
        (candidate) =>
          candidate.config.credentialType === credentialType &&
          candidate.config.requiresBaseUrl === requiresBaseUrl &&
          candidate.catalogue === catalogue &&
          candidate.freeTextModel === freeTextModel,
      );
      expect(row, adapter).toBeDefined();
      expect(settingsOnlyReason(adapter), adapter).toBe(row!.reason);
      expect(
        isInlineConfigurable(ADAPTER_CONFIG[adapter], seedFor(adapter), freeTextModel),
        adapter,
      ).toBe(row!.inline);
    }
  });
});

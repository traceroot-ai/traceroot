import { describe, it, expect } from "vitest";
import { ADAPTER_MODELS, SYSTEM_MODELS, ADAPTER_API_PROTOCOL, LLMAdapter } from "../llm-providers";

describe("ADAPTER_MODELS", () => {
  it("contains no duplicate model IDs within a single adapter", () => {
    for (const [adapter, models] of Object.entries(ADAPTER_MODELS)) {
      if (!models) continue;
      const ids = models.map((m) => m.id);
      const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
      expect(dupes, `adapter "${adapter}" has duplicate IDs: ${dupes.join(", ")}`).toEqual([]);
    }
  });

  it("has non-empty label for every model", () => {
    for (const [adapter, models] of Object.entries(ADAPTER_MODELS)) {
      if (!models) continue;
      for (const model of models) {
        expect(
          model.label.trim().length,
          `adapter "${adapter}", model "${model.id}" has empty label`,
        ).toBeGreaterThan(0);
      }
    }
  });

  describe("apiProtocol consistency with SYSTEM_MODELS", () => {
    const systemModelMap = new Map<string, { apiProtocol: string; provider: string }>();
    for (const system of SYSTEM_MODELS) {
      for (const model of system.models) {
        if (model.apiProtocol) {
          systemModelMap.set(model.id, {
            apiProtocol: model.apiProtocol,
            provider: system.piAIProvider,
          });
        }
      }
    }

    it("matches SYSTEM_MODELS apiProtocol overrides for shared model IDs", () => {
      for (const [adapter, models] of Object.entries(ADAPTER_MODELS)) {
        if (!models) continue;
        for (const model of models) {
          const systemEntry = systemModelMap.get(model.id);
          if (!systemEntry) continue;

          expect(
            model.apiProtocol,
            `adapter "${adapter}", model "${model.id}" requires apiProtocol ` +
              `"${systemEntry.apiProtocol}" (set in SYSTEM_MODELS for ${systemEntry.provider}) ` +
              `but ADAPTER_MODELS has "${model.apiProtocol ?? "(none)"}"`,
          ).toBe(systemEntry.apiProtocol);
        }
      }
    });
  });

  describe("adapter coverage", () => {
    const freeTextAdapters = new Set(["azure", "amazon-bedrock", "openrouter"]);

    it("every non-free-text adapter has a curated model list", () => {
      for (const adapter of Object.values(LLMAdapter)) {
        if (freeTextAdapters.has(adapter)) continue;
        expect(
          ADAPTER_MODELS[adapter],
          `adapter "${adapter}" is not free-text but has no entry in ADAPTER_MODELS`,
        ).toBeDefined();
        expect(ADAPTER_MODELS[adapter]!.length).toBeGreaterThan(0);
      }
    });

    it("free-text adapters do not have curated model lists", () => {
      for (const adapter of freeTextAdapters) {
        expect(
          ADAPTER_MODELS[adapter as LLMAdapter],
          `adapter "${adapter}" should use free-text input, not a curated list`,
        ).toBeUndefined();
      }
    });
  });

  describe("model ID format", () => {
    it("model IDs contain no leading or trailing whitespace", () => {
      for (const [adapter, models] of Object.entries(ADAPTER_MODELS)) {
        if (!models) continue;
        for (const model of models) {
          expect(model.id, `adapter "${adapter}" model "${model.id}" has whitespace`).toBe(
            model.id.trim(),
          );
        }
      }
    });

    it("model IDs are non-empty strings", () => {
      for (const [adapter, models] of Object.entries(ADAPTER_MODELS)) {
        if (!models) continue;
        for (const model of models) {
          expect(model.id.length, `adapter "${adapter}" has empty model ID`).toBeGreaterThan(0);
        }
      }
    });
  });

  describe("protocol references are valid", () => {
    it("every apiProtocol override in ADAPTER_MODELS references an existing protocol", () => {
      const allProtocols = new Set(Object.values(ADAPTER_API_PROTOCOL));
      for (const system of SYSTEM_MODELS) {
        allProtocols.add(system.apiProtocol);
        for (const m of system.models) {
          if (m.apiProtocol) allProtocols.add(m.apiProtocol);
        }
      }

      for (const [adapter, models] of Object.entries(ADAPTER_MODELS)) {
        if (!models) continue;
        for (const model of models) {
          if (!model.apiProtocol) continue;
          expect(
            allProtocols.has(model.apiProtocol),
            `adapter "${adapter}", model "${model.id}" has unknown apiProtocol "${model.apiProtocol}"`,
          ).toBe(true);
        }
      }
    });
  });
});

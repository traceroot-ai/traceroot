import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  ADAPTER_MODELS,
  SYSTEM_MODELS,
  ADAPTER_API_PROTOCOL,
  LLMAdapter,
  DETECTOR_SYSTEM_DEFAULT_MODEL_ID,
  defaultApiProtocol,
  ADAPTER_CONFIG,
  PROVIDER_PRIORITY,
} from "../llm-providers.ts";

describe("defaultApiProtocol", () => {
  it("prefers the catalog entry's own protocol over the adapter default", () => {
    expect(defaultApiProtocol("openai", "o3")).toBe("openai-completions");
    expect(defaultApiProtocol("openai", "o4-mini")).toBe("openai-completions");
    expect(defaultApiProtocol("openai", "gpt-5")).toBe("openai-responses");
  });

  it("falls back to the adapter default for unknown models and no model", () => {
    expect(defaultApiProtocol("openai", "some-future-model")).toBe("openai-responses");
    expect(defaultApiProtocol("openai")).toBe("openai-responses");
    expect(defaultApiProtocol("deepseek", "deepseek-chat")).toBe("openai-completions");
  });

  it("is empty for an unknown adapter", () => {
    expect(defaultApiProtocol("nope", "x")).toBe("");
  });
});

describe("ADAPTER_MODELS", () => {
  it("contains no duplicate model IDs within a single adapter", () => {
    for (const [adapter, models] of Object.entries(ADAPTER_MODELS)) {
      if (!models) continue;
      const ids = models.map((m) => m.id);
      const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
      expect(dupes, `adapter "${adapter}" has duplicate IDs: ${dupes.join(", ")}`).toEqual([]);
    }
  });

  it("label equals id for every model", () => {
    for (const [adapter, models] of Object.entries(ADAPTER_MODELS)) {
      if (!models) continue;
      for (const model of models) {
        expect(
          model.label,
          `adapter "${adapter}", model "${model.id}" has label "${model.label}" — should equal id`,
        ).toBe(model.id);
      }
    }

    for (const system of SYSTEM_MODELS) {
      for (const model of system.models) {
        expect(
          model.label,
          `system provider "${system.provider}", model "${model.id}" has label "${model.label}" — should equal id`,
        ).toBe(model.id);
      }
    }
  });

  it("keeps the detector system default in the system model catalog", () => {
    const systemModelIds = SYSTEM_MODELS.flatMap((system) =>
      system.models.map((model) => model.id),
    );

    expect(systemModelIds).toContain(DETECTOR_SYSTEM_DEFAULT_MODEL_ID);
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

function getTableRows(docPath: URL, heading: string): { provider: string; ids: string[] }[] {
  const content = readFileSync(docPath, "utf8");
  const lines = content.split("\n");
  const rows = [];

  let inSection = false;
  let inTable = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(heading)) {
      inSection = true;
      continue;
    }
    if (inSection && lines[i].startsWith("## ")) {
      break; // next section
    }

    if (inSection) {
      if (!inTable && lines[i].startsWith("|")) {
        inTable = true;
        // skip header and separator
        i++; // skip header row
        // the next might be separator
        if (lines[i] && lines[i].startsWith("|-")) {
          continue;
        } else {
          // fallback if missing
          i--;
        }
      } else if (inTable && lines[i].startsWith("|")) {
        const parts = lines[i].split("|").map((s) => s.trim());
        if (parts.length >= 3) {
          const provider = parts[1];
          const modelsCol = parts[2];
          const ids = [...modelsCol.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
          rows.push({ provider, ids });
        }
      } else if (inTable && !lines[i].startsWith("|") && lines[i].trim() !== "") {
        inTable = false;
      }
    }
  }
  return rows;
}

const BYOK_DOC = new URL("../../../../../docs/ai-agent/byok.mdx", import.meta.url);

describe("docs stay in sync with SYSTEM_MODELS", () => {
  // The BYOK docs table is a hand-maintained copy of SYSTEM_MODELS. Without this
  // check, adding a model here silently leaves the docs stale (see #1431).

  it.each(SYSTEM_MODELS.map((s) => [s.provider, s.models.map((m) => m.id)]))(
    "the byok.mdx Default Models table lists %s's models in SYSTEM_MODELS order",
    (provider, expectedIds) => {
      const rows = getTableRows(BYOK_DOC, "## Default Models");
      const row = rows.find((r) => r.provider === provider);

      expect(
        row,
        `no "${provider}" row in the Default Models table of docs/ai-agent/byok.mdx`,
      ).toBeDefined();

      expect(
        row.ids,
        `docs/ai-agent/byok.mdx Default Models table is out of sync with SYSTEM_MODELS for ${provider} — update the table`,
      ).toEqual([...expectedIds]);
    },
  );
});

describe("docs stay in sync with ADAPTER_MODELS (BYOK model catalog)", () => {
  it("every ADAPTER_MODELS key has a row and ids equal the catalog ids in order", () => {
    const rows = getTableRows(BYOK_DOC, "## BYOK model catalog");

    for (const [adapter, models] of Object.entries(ADAPTER_MODELS)) {
      if (!models || models.length === 0) continue;

      const label = ADAPTER_CONFIG[adapter].label;
      const row = rows.find((r) => r.provider === label);

      expect(
        row,
        `no "${label}" row in the BYOK model catalog table of docs/ai-agent/byok.mdx (update the table)`,
      ).toBeDefined();

      const expectedIds = models.map((m) => m.id);
      expect(
        row.ids,
        `BYOK model catalog for "${label}" is out of sync with ADAPTER_MODELS — update the table`,
      ).toEqual(expectedIds);
    }
  });

  it("every id in the catalog table exists in ADAPTER_MODELS under that provider (no stale ids)", () => {
    const rows = getTableRows(BYOK_DOC, "## BYOK model catalog");

    for (const row of rows) {
      const adapterEntry = Object.entries(ADAPTER_CONFIG).find(
        ([_, config]) => config.label === row.provider,
      );
      expect(
        adapterEntry,
        `Unknown provider "${row.provider}" in BYOK model catalog table`,
      ).toBeDefined();

      const adapterKey = adapterEntry[0];
      const codeModels = ADAPTER_MODELS[adapterKey] || [];
      const codeIds = new Set(codeModels.map((m) => m.id));

      for (const docId of row.ids) {
        expect(
          codeIds.has(docId),
          `Stale ID "${docId}" found in BYOK model catalog table under "${row.provider}" — remove it or add it to ADAPTER_MODELS`,
        ).toBe(true);
      }
    }
  });

  it("there are no rows for unknown providers", () => {
    const rows = getTableRows(BYOK_DOC, "## BYOK model catalog");
    const validLabels = new Set(Object.values(ADAPTER_CONFIG).map((c) => c.label));

    for (const row of rows) {
      expect(
        validLabels.has(row.provider),
        `Unknown provider "${row.provider}" found in BYOK model catalog table`,
      ).toBe(true);
    }
  });

  it("every free-text adapter is mentioned in the note", () => {
    const content = readFileSync(BYOK_DOC, "utf8");
    const freeTextAdapters = PROVIDER_PRIORITY.filter((adapter) => !ADAPTER_MODELS[adapter]);

    // the text is below the table
    const noteMatch = content.match(/\*\*Note:\*\* (.*)/);
    expect(noteMatch, "Missing **Note:** below BYOK model catalog table").toBeTruthy();

    const noteText = noteMatch[1];

    for (const adapter of freeTextAdapters) {
      const label = ADAPTER_CONFIG[adapter].label;
      expect(
        noteText.includes(label) || noteText.includes(adapter),
        `Free-text adapter "${label}" (${adapter}) is missing from the BYOK model catalog note`,
      ).toBe(true);
    }
  });
});

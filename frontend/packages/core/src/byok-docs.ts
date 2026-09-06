import { ADAPTER_MODELS, SYSTEM_MODELS, LLMAdapter } from "./llm-providers";

/** Marks the region of docs/ai-agent/byok.mdx this module owns. */
export const BYOK_DOC_START = "{/* generated:byok-models */}";
export const BYOK_DOC_END = "{/* end generated:byok-models */}";

/** Display names for the adapters, matching the `provider` field on SYSTEM_MODELS. */
const PROVIDER_LABELS: Partial<Record<LLMAdapter, string>> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google (Gemini)",
  deepseek: "DeepSeek",
  xai: "xAI",
  moonshot: "Kimi",
  zai: "GLM",
};

/**
 * The models a BYOK key adds beyond the system list — i.e. everything in the
 * selectable catalog that TraceRoot does not already run on its own keys.
 */
export function byokOnlyModels(): { provider: string; ids: string[] }[] {
  return Object.entries(ADAPTER_MODELS)
    .map(([adapter, models]) => {
      const provider = PROVIDER_LABELS[adapter as LLMAdapter];
      if (!provider || !models) return null;
      const systemIds = new Set(
        SYSTEM_MODELS.find((s) => s.provider === provider)?.models.map((m) => m.id) ?? [],
      );
      const ids = models.map((m) => m.id).filter((id) => !systemIds.has(id));
      return ids.length ? { provider, ids } : null;
    })
    .filter((row): row is { provider: string; ids: string[] } => row !== null);
}

/** Renders the generated region, markers included. */
export function renderByokModelsSection(): string {
  const rows = byokOnlyModels().map(
    ({ provider, ids }) => `| ${provider} | ${ids.map((id) => `\`${id}\``).join(", ")} |`,
  );

  return [
    BYOK_DOC_START,
    "",
    '<Accordion title="Models your own key adds">',
    "",
    "| Provider | Models |",
    "|----------|--------|",
    ...rows,
    "",
    "</Accordion>",
    "",
    BYOK_DOC_END,
  ].join("\n");
}

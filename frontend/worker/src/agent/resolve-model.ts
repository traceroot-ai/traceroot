/** The model a system agent run uses, shared by RCA and Loop runs. */
import { prisma, SYSTEM_MODELS, ModelSource } from "@traceroot/core";
import {
  byokProviderMissingMessage,
  fetchProviderConfig,
  resolvePiModel,
} from "@traceroot/core/model-resolver";

const LOG_PREFIX = "[resolve-model]";

export interface ResolvedModel {
  model: string;
  providerName: string;
  source: ModelSource;
}

/** A BYOK model whose saved provider is gone or disabled; `error` is user-facing. */
export interface ByokProviderMissing {
  error: string;
}

// Resolve a project-configured rca_model to the agent service body fields.
// Uses the same pattern as sandbox-eval.ts: reads the provider from saved
// config (BYOK) or the shared system-model resolver — no fragile prefix
// matching or adapter guessing.
// Returns null when the model is unset or unknown (caller should omit fields),
// and ByokProviderMissing when the named BYOK provider cannot be used.
export async function resolveProjectModel(
  rcaModel: string | null | undefined,
  rcaProvider: string | null | undefined,
  rcaSource: string | null | undefined,
  workspaceId: string,
): Promise<ResolvedModel | ByokProviderMissing | null> {
  if (!rcaModel) return null;

  // 1. BYOK: read provider from saved config (same pattern as sandbox-eval.ts)
  if (rcaSource === "byok" && rcaProvider) {
    const providerConfig = await fetchProviderConfig(workspaceId, rcaProvider);
    if (!providerConfig) {
      console.warn(
        `${LOG_PREFIX} BYOK provider "${rcaProvider}" not found or disabled in workspace ${workspaceId}`,
      );
      return { error: byokProviderMissingMessage(rcaProvider) };
    }
    const model = resolvePiModel(rcaModel, providerConfig);
    // Forward the saved BYOK provider LABEL (e.g. "myopenai"), not the pi-ai
    // provider name. The agent resolves BYOK via fetchProviderConfig(workspaceId,
    // providerName), which keys on ModelProvider.provider (the user label).
    return { model: model.id, providerName: rcaProvider, source: ModelSource.BYOK };
  }

  // 2. Formerly BYOK-only models must be explicitly selected as system models.
  for (const group of SYSTEM_MODELS) {
    const entry = group.models.find((m) => m.id === rcaModel);
    if (entry && (!entry.requiresExplicitSource || rcaSource === ModelSource.SYSTEM)) {
      const model = resolvePiModel(rcaModel, null);
      return { model: model.id, providerName: model.provider, source: ModelSource.SYSTEM };
    }
  }

  // 3. Legacy BYOK fallback for pre-existing configs
  const legacy = await resolveLegacyByok(rcaModel, workspaceId);
  if (legacy) return legacy;

  console.warn(`${LOG_PREFIX} Unknown rca_model "${rcaModel}", falling back to default`);
  return null;
}

// 3. Legacy BYOK fallback: projects that saved a BYOK model before
//    rcaSource and rcaProvider fields existed have both set to NULL.
//    Try to resolve the model from the workspace's enabled providers.
async function resolveLegacyByok(
  rcaModel: string,
  workspaceId: string,
): Promise<ResolvedModel | null> {
  try {
    const dbProviders = await prisma.modelProvider.findMany({
      where: { workspaceId, enabled: true },
      select: { provider: true, customModels: true },
      orderBy: { id: "asc" },
    });

    for (const p of dbProviders) {
      if (p.customModels.some((m) => m.trim() === rcaModel)) {
        const providerConfig = await fetchProviderConfig(workspaceId, p.provider);
        if (providerConfig) {
          const model = resolvePiModel(rcaModel, providerConfig);
          // Forward the BYOK provider LABEL the agent expects (see step 1 above).
          return { model: model.id, providerName: p.provider, source: ModelSource.BYOK };
        }
      }
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} Failed to resolve legacy BYOK for workspace ${workspaceId}:`, err);
  }
  return null;
}

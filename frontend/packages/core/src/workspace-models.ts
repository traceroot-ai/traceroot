import type { Prisma } from "@prisma/client";
import { prisma } from "./lib/prisma.ts";
import {
  ADAPTER_MODELS,
  DETECTOR_SYSTEM_DEFAULT_MODEL_ID,
  ModelSource,
  SYSTEM_MODELS,
  type LLMAdapter,
} from "./llm-providers.ts";

/** One model a workspace can run a detector on. */
export interface WorkspaceModel {
  id: string;
  label: string;
  /** BYOK only: whether the id is in the adapter's curated catalog. Free-text
   *  adapters have no catalog, so every custom model on them is supported. */
  supported?: boolean;
}

/** A provider and the models it offers, as the model pickers group them. */
export interface WorkspaceModelProvider {
  /** The provider's name: the system provider ("Anthropic") or the BYOK
   *  row's user-given label, which is what a detector's detectionProvider
   *  stores. */
  provider: string;
  adapter: string;
  source: ModelSource;
  models: WorkspaceModel[];
}

export interface WorkspaceModels {
  systemModels: WorkspaceModelProvider[];
  byokProviders: WorkspaceModelProvider[];
}

/** The client `listWorkspaceModels` reads providers through: the shared client
 *  or a transaction client. */
export type ModelProviderReader = Pick<Prisma.TransactionClient, "modelProvider">;

/** What a detector write says about the model it should run on. */
export interface DetectorModelChoice {
  detectionSource?: string | null;
  detectionModel?: string | null;
  detectionProvider?: string | null;
}

/**
 * The models a workspace can run a detector on: the system catalog for every
 * provider whose API key the process has, plus the workspace's enabled BYOK
 * providers with the models configured on each.
 *
 * One list for every surface that offers or checks a model — the web app's
 * picker, the agent's list tool and the detector write validation — so an id
 * one of them accepts is an id the others show.
 *
 * Args:
 *   workspaceId: The workspace whose BYOK providers are listed.
 *   options.db: The client to read providers through; a transaction client
 *     inside a write, the shared client otherwise.
 *   options.env: Where provider API keys are looked up.
 *
 * Returns:
 *   The system providers and BYOK providers with their models.
 */
export async function listWorkspaceModels(
  workspaceId: string,
  options: { db?: ModelProviderReader; env?: NodeJS.ProcessEnv } = {},
): Promise<WorkspaceModels> {
  const env = options.env ?? process.env;
  const db = options.db ?? prisma;

  const systemModels: WorkspaceModelProvider[] = SYSTEM_MODELS.filter((s) => !!env[s.envVar]).map(
    (s) => ({
      provider: s.provider,
      adapter: s.piAIProvider,
      source: ModelSource.SYSTEM,
      // The catalog entries as they are: the picker's contract predates this
      // helper and carries the entry's protocol and cost fields through.
      models: s.models,
    }),
  );

  const rows = await db.modelProvider.findMany({
    where: { workspaceId, enabled: true },
    select: { adapter: true, provider: true, customModels: true },
  });
  const byokProviders: WorkspaceModelProvider[] = rows.map((p) => {
    const catalog = ADAPTER_MODELS[p.adapter as LLMAdapter];
    return {
      provider: p.provider,
      adapter: p.adapter,
      source: ModelSource.BYOK,
      models: (p.customModels || [])
        .map((id) => id.trim())
        .filter(Boolean)
        .map((id) => ({
          id,
          label: id,
          supported: catalog ? catalog.some((m) => m.id === id) : true,
        })),
    };
  });

  return { systemModels, byokProviders };
}

/**
 * A provider name or model id as a JSON string literal. BYOK names and custom
 * model ids are typed by workspace members, and the messages here are read
 * by an agent as tool output: encoding keeps a quote, a newline or a
 * sentence inside a name from reading as part of the message, and gives
 * the agent an exact string to copy.
 */
function quoted(value: string): string {
  return JSON.stringify(value);
}

function idList(models: WorkspaceModel[]): string {
  return models.map((m) => quoted(m.id)).join(", ") || "(none configured)";
}

function describeSystemModels(models: WorkspaceModels): string {
  const ids = models.systemModels.flatMap((p) => p.models.map((m) => quoted(m.id)));
  return ids.length > 0 ? `System models: ${ids.join(", ")}.` : "No system models are available.";
}

function describeByokProviders(models: WorkspaceModels): string {
  if (models.byokProviders.length === 0) return "No BYOK providers are configured.";
  const entries = models.byokProviders.map((p) => `${quoted(p.provider)}: ${idList(p.models)}`);
  return `BYOK providers (detection_source "byok", detection_provider set to the name): ${entries.join("; ")}.`;
}

/**
 * Why a detector's model choice cannot run in this workspace, or null when it
 * can. Checked on the write so a wrong id fails the request instead of the
 * detector's first run.
 *
 * A system choice (the default source) needs no provider and may leave the
 * model unset for the default; a set model must be in the system list. A BYOK
 * choice names an enabled provider and one of the models configured on it.
 *
 * Args:
 *   choice: The source, model and provider the write carries.
 *   models: The workspace's models, from `listWorkspaceModels`.
 *
 * Returns:
 *   A message naming the problem and the models the workspace can use, or
 *   null when the choice is valid.
 */
export function detectorModelProblem(
  choice: DetectorModelChoice,
  models: WorkspaceModels,
): string | null {
  const source = choice.detectionSource ?? ModelSource.SYSTEM;
  const model = choice.detectionModel || null;
  const provider = choice.detectionProvider || null;

  if (source === ModelSource.SYSTEM) {
    if (model === null) return null;
    const known = models.systemModels.some((p) => p.models.some((m) => m.id === model));
    if (known) return null;
    return (
      `detection_model ${quoted(model)} is not a system model this workspace can use. ` +
      `${describeSystemModels(models)} ${describeByokProviders(models)} ` +
      `Leave detection_model unset for the default (${DETECTOR_SYSTEM_DEFAULT_MODEL_ID}).`
    );
  }

  if (provider === null) {
    return (
      `detection_provider is required when detection_source is "byok". ` +
      describeByokProviders(models)
    );
  }
  const row = models.byokProviders.find((p) => p.provider === provider);
  if (!row) {
    return (
      `detection_provider ${quoted(provider)} is not an enabled model provider in this workspace. ` +
      describeByokProviders(models)
    );
  }
  if (model === null) {
    return (
      `detection_model is required when detection_source is "byok". ` +
      `Models on ${quoted(provider)}: ${idList(row.models)}.`
    );
  }
  if (row.models.some((m) => m.id === model)) return null;
  return (
    `detection_model ${quoted(model)} is not configured on provider ${quoted(provider)}. ` +
    `Models on ${quoted(provider)}: ${idList(row.models)}.`
  );
}

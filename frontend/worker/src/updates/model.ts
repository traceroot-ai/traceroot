import { getEnvApiKey } from "@earendil-works/pi-ai/compat";
import type { Api, Model } from "@earendil-works/pi-ai";
import { fetchProviderConfig, resolvePiModel } from "@traceroot/core/model-resolver";
import { resolveDetectorApiKey } from "../detection/sandbox-eval.js";

/**
 * The model an update runs on, and the key it runs with.
 *
 * A project that brought its own provider key (BYOK) for its analysis agent
 * uses that provider and its model, so the spend stays on its own account.
 * Everything else runs on a system model: UPDATE_AGENT_MODEL if set, else the
 * first of the defaults below whose provider has a key in this deployment.
 */
const DEFAULT_MODEL_IDS = ["claude-sonnet-4-5", "gpt-5.4-mini"];

export interface ProjectModelSource {
  workspaceId: string;
  rcaSource: string | null;
  rcaProvider: string | null;
  rcaModel: string | null;
}

export type ResolvedModel =
  | { ok: true; model: Model<Api>; apiKey: string; isByok: boolean }
  | { ok: false; error: string };

export async function resolveUpdateModel(
  project: ProjectModelSource,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedModel> {
  if (project.rcaSource === "byok" && project.rcaProvider) {
    const config = await fetchProviderConfig(project.workspaceId, project.rcaProvider);
    if (config) {
      const model = resolvePiModel(project.rcaModel ?? undefined, config);
      const apiKey = await resolveDetectorApiKey(project.workspaceId, config, model.provider);
      if (apiKey) return { ok: true, model, apiKey, isByok: true };
    }
  }
  const wanted = env.UPDATE_AGENT_MODEL ? [env.UPDATE_AGENT_MODEL] : DEFAULT_MODEL_IDS;
  for (const id of wanted) {
    const model = resolvePiModel(id, null);
    const apiKey =
      getEnvApiKey(model.provider) ??
      (await resolveDetectorApiKey(project.workspaceId, null, model.provider));
    if (apiKey) return { ok: true, model, apiKey, isByok: false };
  }
  return {
    ok: false,
    error: `No model API key is configured for the update agent (tried ${wanted.join(", ")}).`,
  };
}

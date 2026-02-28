/**
 * Model Provider API functions (BYOK)
 */
import { fetchNextApi } from "./client";

export interface ModelProviderResponse {
  id: string;
  adapter: string;
  provider: string; // user-defined label
  keyPreview: string;
  baseUrl: string | null;
  customModels: string[];
  withDefaultModels: boolean;
  config: Record<string, unknown> | null;
  enabled: boolean;
  createdBy: string;
  createTime: string;
  updateTime: string;
}

export interface AvailableLlmModel {
  id: string;
  label: string;
}

export interface SystemModelGroup {
  provider: string;
  source: "system";
  models: AvailableLlmModel[];
}

export interface ByokProviderGroup {
  provider: string; // user-defined label
  adapter: string;
  source: "byok";
  models: AvailableLlmModel[];
}

export interface LlmModelsResponse {
  systemModels: SystemModelGroup[];
  byokProviders: ByokProviderGroup[];
}

export async function getModelProviders(
  workspaceId: string,
): Promise<{ providers: ModelProviderResponse[]; byokEnabled: boolean }> {
  return fetchNextApi(`/workspaces/${workspaceId}/model-providers`);
}

export async function createModelProvider(
  workspaceId: string,
  data: {
    adapter: string;
    provider: string;
    apiKey?: string;
    baseUrl?: string;
    customModels?: string[];
    withDefaultModels?: boolean;
    config?: Record<string, unknown>;
    enabled?: boolean;
    awsAccessKeyId?: string;
    awsSecretAccessKey?: string;
    awsRegion?: string;
    useDefaultCredentials?: boolean;
  },
): Promise<ModelProviderResponse> {
  return fetchNextApi(`/workspaces/${workspaceId}/model-providers`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function updateModelProvider(
  workspaceId: string,
  providerId: string,
  data: {
    provider?: string;
    apiKey?: string;
    baseUrl?: string | null;
    customModels?: string[];
    withDefaultModels?: boolean;
    config?: Record<string, unknown>;
    enabled?: boolean;
    awsAccessKeyId?: string;
    awsSecretAccessKey?: string;
    awsRegion?: string;
    useDefaultCredentials?: boolean;
  },
): Promise<ModelProviderResponse> {
  return fetchNextApi(`/workspaces/${workspaceId}/model-providers/${providerId}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function deleteModelProvider(
  workspaceId: string,
  providerId: string,
): Promise<void> {
  return fetchNextApi(`/workspaces/${workspaceId}/model-providers/${providerId}`, {
    method: "DELETE",
  });
}

export async function testModelProvider(
  workspaceId: string,
  data: {
    adapter: string;
    apiKey?: string;
    baseUrl?: string;
    config?: Record<string, unknown>;
    awsAccessKeyId?: string;
    awsSecretAccessKey?: string;
    awsRegion?: string;
    useDefaultCredentials?: boolean;
  },
): Promise<{ success: boolean; error?: string }> {
  return fetchNextApi(`/workspaces/${workspaceId}/model-providers/test`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function getAvailableLlmModels(
  workspaceId: string,
): Promise<LlmModelsResponse> {
  return fetchNextApi(`/workspaces/${workspaceId}/llm-models`);
}

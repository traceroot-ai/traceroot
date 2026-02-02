/**
 * Access Key API functions
 */
import { fetchNextApi } from "./client";
import type { AccessKey, AccessKeyCreatedResponse } from "@/types/api";

export async function getAccessKeys(projectId: string): Promise<{ access_keys: AccessKey[] }> {
  return fetchNextApi<{ access_keys: AccessKey[] }>(`/projects/${projectId}/api-keys`);
}

export async function createAccessKey(
  projectId: string,
  name?: string
): Promise<{ data: AccessKeyCreatedResponse }> {
  const response = await fetchNextApi<AccessKeyCreatedResponse>(`/projects/${projectId}/api-keys`, {
    method: "POST",
    body: JSON.stringify({ name: name || null }),
  });
  return { data: response };
}

export async function updateAccessKey(
  projectId: string,
  keyId: string,
  name: string | null
): Promise<AccessKey> {
  return fetchNextApi<AccessKey>(`/projects/${projectId}/api-keys/${keyId}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export async function deleteAccessKey(projectId: string, keyId: string): Promise<void> {
  return fetchNextApi<void>(`/projects/${projectId}/api-keys/${keyId}`, {
    method: "DELETE",
  });
}

// Legacy aliases
export const getApiKeys = getAccessKeys;
export const createApiKey = createAccessKey;
export const updateApiKey = updateAccessKey;
export const deleteApiKey = deleteAccessKey;

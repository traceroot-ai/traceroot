/**
 * Custom Model Pricing API functions
 */
import { fetchNextApi } from "./client";

export interface CustomModelPrice {
  id: string;
  workspaceId: string;
  modelName: string;
  matchPattern: string | null;
  inputPrice: number;
  outputPrice: number;
  cacheReadPrice: number | null;
  cacheWritePrice: number | null;
  createdBy: string;
  createTime: string;
  updateTime: string;
}

export interface CreateCustomModelPriceInput {
  modelName: string;
  matchPattern?: string;
  inputPrice: number;
  outputPrice: number;
  cacheReadPrice?: number;
  cacheWritePrice?: number;
}

export interface UpdateCustomModelPriceInput {
  modelName?: string;
  matchPattern?: string | null;
  inputPrice?: number;
  outputPrice?: number;
  cacheReadPrice?: number | null;
  cacheWritePrice?: number | null;
}

export async function getCustomModelPrices(
  workspaceId: string,
): Promise<{ prices: CustomModelPrice[] }> {
  return fetchNextApi(`/workspaces/${workspaceId}/custom-model-prices`);
}

export async function createCustomModelPrice(
  workspaceId: string,
  data: CreateCustomModelPriceInput,
): Promise<{ price: CustomModelPrice }> {
  return fetchNextApi(`/workspaces/${workspaceId}/custom-model-prices`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function updateCustomModelPrice(
  workspaceId: string,
  priceId: string,
  data: UpdateCustomModelPriceInput,
): Promise<{ price: CustomModelPrice }> {
  return fetchNextApi(`/workspaces/${workspaceId}/custom-model-prices/${priceId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function deleteCustomModelPrice(
  workspaceId: string,
  priceId: string,
): Promise<{ success: boolean }> {
  return fetchNextApi(`/workspaces/${workspaceId}/custom-model-prices/${priceId}`, {
    method: "DELETE",
  });
}

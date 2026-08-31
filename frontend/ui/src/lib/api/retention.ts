import { ApiError } from "./client";

export interface RetentionErrorDetail {
  message: string;
  retention_days: number;
  cutoff: string;
  plan: string;
}

export function isRetentionError(
  error: unknown,
): error is ApiError & { detail: RetentionErrorDetail } {
  if (!(error instanceof ApiError) || error.status !== 403) return false;
  const d = error.detail;
  return typeof d === "object" && d !== null && "retention_days" in d && "plan" in d;
}

export function getRetentionDetail(error: unknown): RetentionErrorDetail | null {
  if (!isRetentionError(error)) return null;
  return error.detail;
}

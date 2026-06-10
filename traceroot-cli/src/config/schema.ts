/**
 * Shape and validation for ~/.traceroot/config.json.
 *
 * Intentionally dependency-free — no Zod or ajv — to keep the package lean.
 * A hand-written type guard is sufficient for a flat config with two fields.
 */

export interface TraceRootConfig {
  /** Base URL of the TraceRoot API, e.g. https://api.traceroot.ai */
  apiUrl: string;
  /** Active workspace slug */
  workspace?: string;
  /** Personal access token (written by `traceroot login token`) */
  token?: string;
}

export const DEFAULT_API_URL = "https://api.traceroot.ai";

/** Type guard — validates that an unknown value is a well-formed TraceRootConfig. */
export function isValidConfig(value: unknown): value is TraceRootConfig {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj["apiUrl"] !== "string") return false;
  if ("workspace" in obj && typeof obj["workspace"] !== "string") return false;
  if ("token" in obj && typeof obj["token"] !== "string") return false;
  return true;
}

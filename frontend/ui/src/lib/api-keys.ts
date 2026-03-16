import { createHash, randomUUID } from "crypto";

/**
 * Generate a new API key with a prefix.
 * Format: tr-<uuid> e.g. tr-d0a3ee92-659e-4f63-ae11-8ca6f57657e3
 */
export function generateApiKey(): string {
  const uuid = randomUUID();
  return `tr-${uuid}`;
}

/**
 * Extract a hint from an API key for display.
 * Format: "tr-xxxx-yyyy" where xxxx is first 4 chars of UUID and yyyy is last 4 chars.
 * Example: "tr-d0a3ee92-659e-4f63-ae11-8ca6f57657e3" -> "tr-d0a3-57e3"
 */
export function getKeyPrefix(apiKey: string): string {
  // apiKey is like "tr-d0a3ee92-659e-4f63-ae11-8ca6f57657e3"
  const prefix = apiKey.substring(0, 7); // "tr-d0a3"
  const suffix = apiKey.substring(apiKey.length - 4); // "57e3"
  return `${prefix}-${suffix}`;
}

/**
 * Hash an API key using SHA256.
 * SHA256 is appropriate for high-entropy random API keys (not user passwords).
 */
export function hashApiKey(apiKey: string): string {
  // codeql[js/insufficient-password-hash]
  return createHash("sha256").update(apiKey).digest("hex");
}

/**
 * Verify an API key against a stored hash.
 */
export function verifyApiKey(apiKey: string, storedHash: string): boolean {
  const inputHash = hashApiKey(apiKey);
  return inputHash === storedHash;
}

/**
 * Mask an API key for display, showing only prefix.
 * Example: "tr_abc1234..." or "tr_abc1234••••••••"
 */
export function maskApiKey(keyPrefix: string): string {
  return `${keyPrefix}${"•".repeat(10)}...`;
}

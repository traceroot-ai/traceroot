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
 * Extract the prefix from an API key for display.
 * Shows first 4 and last 4 chars of the UUID part: "tr-d0a3...7e3"
 */
export function getKeyPrefix(apiKey: string): string {
  // apiKey is like "tr-d0a3ee92-659e-4f63-ae11-8ca6f57657e3"
  // We want to store enough to identify it: "tr-d0a3ee92"
  return apiKey.substring(0, 14);
}

/**
 * Hash an API key using SHA256.
 * This is what we store in the database for security.
 */
export function hashApiKey(apiKey: string): string {
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

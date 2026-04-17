import { prisma } from "./prisma";
import { decryptKey } from "./encryption";

/** Cache: `${workspaceId}:${provider}` → { key, expiresAt } */
const keyCache = new Map<string, { key: string; expiresAt: number }>();
const CACHE_TTL_MS = 60_000;

/**
 * Resolve an API key for a workspace + provider.
 * Checks BYOK (modelProvider table) first, then falls back to env var.
 *
 * @param workspaceId - workspace to look up BYOK for
 * @param provider    - "anthropic" | "openai" (matches modelProvider.provider in DB)
 * @param envVar      - env var name to fall back to (e.g. "ANTHROPIC_API_KEY")
 */
export async function resolveWorkspaceApiKey(
  workspaceId: string,
  provider: string,
  envVar: string,
): Promise<string> {
  const cacheKey = `${workspaceId}:${provider}`;
  const cached = keyCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.key;
  }

  if (workspaceId) {
    try {
      const row = await prisma.modelProvider.findFirst({
        where: { workspaceId, provider, enabled: true },
        select: { keyCipher: true },
      });
      if (row?.keyCipher) {
        const key = decryptKey(row.keyCipher);
        keyCache.set(cacheKey, { key, expiresAt: Date.now() + CACHE_TTL_MS });
        return key;
      }
    } catch (err) {
      console.warn(`[resolveWorkspaceApiKey] DB lookup failed for ${provider}:`, err);
    }
  }

  const envKey = process.env[envVar] ?? "";
  return envKey;
}
